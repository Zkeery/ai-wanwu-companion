"""Persistent, fail-closed MaaS transport for the opt-in local real website."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

import httpx

REF = 'real-web-20261002-5cny-12requests'
MODELS = {'ling-3.0-flash-vl': ('vision', 200000),
          'qwen3.8-flash': ('text', 1145600), 'wan2.6-t2i': ('image', 16000)}


class Budget:
    def __init__(self, root: Path, endpoint: str, *, reference=REF, budget_micro=5000000,
                 requests_max=12, purpose_limits=None):
        self.root = root
        self.endpoint = endpoint.rstrip('/')
        self.reference, self.budget_micro, self.requests_max = reference, budget_micro, requests_max
        self.purpose_limits = purpose_limits or {}
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = root / 'model-budget.db'
        if self.path.is_symlink() or (self.path.exists() and not self.path.is_file()):
            raise ValueError('unsafe_budget_ledger')
        authorized_file = (root/'authorization.json').exists()
        self._creating = not self.path.exists()
        if authorized_file and self._creating:
            raise ValueError('authorized_ledger_missing')
        with self.db() as db:
            if authorized_file:
                tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not {'authorization','calls'}.issubset(tables) or db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
                    raise ValueError('authorized_ledger_invalid')
            db.execute('CREATE TABLE IF NOT EXISTS authorization (id INTEGER PRIMARY KEY, digest TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, kind TEXT, model TEXT, '
                       'reserved_micro INTEGER, outcome TEXT, started_at REAL, http_status INTEGER)')
            db.execute('CREATE TABLE IF NOT EXISTS stops (reason TEXT PRIMARY KEY, created_at REAL)')
            columns = {r[1] for r in db.execute('PRAGMA table_info(calls)')}
            for name, declaration in [('finished_at','REAL'),('elapsed_ms','REAL')]:
                if name not in columns:
                    db.execute(f'ALTER TABLE calls ADD COLUMN {name} {declaration}')
        self.path.chmod(0o600)
        self._creating = False

    @contextmanager
    def db(self):
        db = (sqlite3.connect(self.path,timeout=10) if self._creating else
              sqlite3.connect(self.path.resolve().as_uri()+'?mode=rw',uri=True,timeout=10))
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def approval(self):
        path = self.root / 'authorization.json'
        if path.is_symlink():
            raise ValueError('unsafe_authorization')
        raw = path.read_bytes()
        data = json.loads(raw)
        if (data.get('authorization_ref') != self.reference or data.get('budget_cny') != self.budget_micro/1000000
                or type(data.get('requests_max')) is not int or data['requests_max'] != self.requests_max
                or data.get('automatic_retries') != 0 or data.get('confirmed') is not True
                or not isinstance(data.get('user_reply'), str) or not data['user_reply'].strip()
                or data.get('target_root') != str(self.root.resolve())
                or data.get('endpoint') != self.endpoint
                or data.get('purpose_limits', {}) != self.purpose_limits):
            raise ValueError('invalid_authorization')
        return hashlib.sha256(raw).hexdigest()

    def claim(self, model, *, purpose=None):
        digest = self.approval()
        kind, amount = MODELS[model]
        if purpose is not None:
            if purpose not in self.purpose_limits or model != 'qwen3.8-flash':
                raise ValueError('unsupported_purpose')
            kind = purpose
        elif self.purpose_limits:
            raise ValueError('explicit_purpose_required')
        call_id = uuid4().hex
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT digest FROM authorization WHERE id=1').fetchone()
            if old and old[0] != digest:
                raise ValueError('authorization_changed')
            count, used, stopped = db.execute('SELECT count(*),coalesce(sum(reserved_micro),0),'
                "coalesce(sum(outcome != 'succeeded'),0) FROM calls").fetchone()
            if stopped or db.execute('SELECT 1 FROM stops').fetchone():
                raise ValueError('previous_request_requires_review')
            if count >= self.requests_max or used + amount > self.budget_micro:
                raise ValueError('budget_exhausted')
            sequence = getattr(self, 'revision_models', None)
            if sequence is not None:
                index = count - self.revision_start
                if index < 0 or index >= len(sequence) or model != sequence[index]:
                    raise ValueError('single_revision_scope_exhausted')
            if purpose and db.execute('SELECT count(*) FROM calls WHERE kind=?',(kind,)).fetchone()[0] >= self.purpose_limits[purpose]:
                raise ValueError('purpose_exhausted')
            db.execute('INSERT OR IGNORE INTO authorization VALUES (1,?)', (digest,))
            db.execute('INSERT INTO calls (id,kind,model,reserved_micro,outcome,started_at,http_status) VALUES (?,?,?,?,?,?,?)',
                       (call_id, kind, model, amount, 'unknown', time.time(), None))
        return call_id

    def settle(self, call_id, outcome, status):
        with self.db() as db:
            now = time.time()
            db.execute("UPDATE calls SET outcome=?,http_status=?,finished_at=?,elapsed_ms=(?-started_at)*1000 "
                       "WHERE id=? AND outcome='unknown'", (outcome,status,now,now,call_id))

    def stop(self, reason):
        if reason not in ('business_failure','price_check_failed','validation_failed'):
            raise ValueError('unsupported_stop_reason')
        with self.db() as db:
            db.execute('INSERT OR IGNORE INTO stops VALUES (?,?)',(reason,time.time()))

    def response_receipt(self, call_id, data):
        """Private allowlisted provider response, never headers or request keys."""
        path = self.root/'provider-responses'
        path.mkdir(exist_ok=True,mode=0o700)
        output = path/(call_id+'.json')
        output.write_text(json.dumps({k:data[k] for k in ('id','request_id','model','usage','choices','data')
                                      if k in data},ensure_ascii=False))
        output.chmod(0o600)

    def status(self):
        with self.db() as db:
            count, used, stopped = db.execute('SELECT count(*),coalesce(sum(reserved_micro),0),'
                "coalesce(sum(outcome != 'succeeded'),0) FROM calls").fetchone()
            stopped = stopped or bool(db.execute('SELECT 1 FROM stops').fetchone())
        try:
            digest = self.approval()
            with self.db() as db:
                old = db.execute('SELECT digest FROM authorization WHERE id=1').fetchone()
            if old and old[0] != digest:
                raise ValueError('authorization_changed')
            authorized = True
        except (OSError, ValueError, TypeError):
            authorized = False
        return dict(authorized=authorized, requests=count, reserved_cny=used/1000000,
                    budget_cny=self.budget_micro/1000000, requests_max=self.requests_max,
                    paused=bool(stopped), automatic_retries=0)


class GuardedStream(httpx.SyncByteStream):
    def __init__(self, stream, budget, call_id, status):
        self.stream, self.budget, self.call_id, self.status = stream, budget, call_id, status
        self.tail = b''
        self.done = False

    def __iter__(self):
        for chunk in self.stream:
            combined = self.tail + chunk
            if b'data: [DONE]' in combined or b'data:[DONE]' in combined:
                self.done = True
            self.tail = combined[-128:]
            yield chunk
        if self.done:
            self.budget.settle(self.call_id, 'succeeded', self.status)

    def close(self):
        try:
            self.stream.close()
        finally:
            if self.done:
                self.budget.settle(self.call_id, 'succeeded', self.status)


def prepare_request(budget: Budget, request):
    try:
        payload = json.loads(request.content)
        model = payload.get('model')
        if model not in MODELS:
            raise ValueError('unsupported_model')
        expected = budget.endpoint + ('/images/generations' if MODELS[model][0] == 'image'
                                      else '/chat/completions')
        if str(request.url) != expected:
            raise ValueError('unsupported_endpoint')
        if model == 'wan2.6-t2i':
            if payload.get('n', 1) != 1 or payload.get('size') != '1024x1024':
                raise ValueError('unsupported_image_bounds')
            if len(str(payload.get('prompt', '')).encode()) > 131072:
                raise ValueError('input_too_large')
        else:
            messages = payload.get('messages')
            if not isinstance(messages, list) or len(request.content) > 24000000:
                raise ValueError('input_too_large')
            text_bytes, images = 0, 0
            for message in messages:
                content = message.get('content', '')
                if isinstance(content, str):
                    text_bytes += len(content.encode())
                elif isinstance(content, list):
                    for part in content:
                        if part.get('type') == 'text':
                            text_bytes += len(str(part.get('text', '')).encode())
                        elif part.get('type') == 'image_url':
                            images += 1
                        else:
                            raise ValueError('unsupported_content')
                else:
                    raise ValueError('unsupported_content')
            if text_bytes > 131072 or images > (1 if model == 'ling-3.0-flash-vl' else 0):
                raise ValueError('input_too_large')
            tokens = payload.get('max_tokens', 8192)
            if type(tokens) is not int or not 1 <= tokens <= 8192:
                raise ValueError('output_too_large')
            payload['max_tokens'] = tokens
            headers = dict(request.headers)
            headers.pop('content-length', None)
            request = httpx.Request(request.method, request.url, headers=headers,
                content=json.dumps(payload).encode(), extensions=request.extensions)
        call_id = budget.claim(model)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        raise httpx.RequestError('真实AI体验尚未授权、额度用尽或前次结果需核查', request=request) from None
    return request, payload, call_id


def install(budget: Budget):
    """Wrap send, covering both Client.post and Client.stream, before app import."""
    original = httpx.Client.send

    def send(client, request, **kwargs):
        if request.method != 'POST':
            return original(client, request, **kwargs)
        request, payload, call_id = prepare_request(budget, request)
        response = original(client, request, **kwargs)
        if response.status_code >= 400:
            budget.settle(call_id, 'failed', response.status_code)
        elif payload.get('stream') and kwargs.get('stream'):
            response.stream = GuardedStream(response.stream, budget, call_id, response.status_code)
        elif response.is_stream_consumed:
            try:
                data = response.json()
                if isinstance(data,dict): budget.response_receipt(call_id,data)
            except (ValueError,TypeError):
                pass
            budget.settle(call_id, 'succeeded', response.status_code)
        # Interrupted requests remain unknown, including interrupted streams.
        return response

    httpx.Client.send = send
    return original


class GuardedAsyncBody(httpx.AsyncByteStream):
    """Track the bounded HTTP body used by the non-SSE life adapter."""
    def __init__(self, stream, budget, call_id, status):
        self.stream, self.budget, self.call_id, self.status = stream, budget, call_id, status

    async def __aiter__(self):
        body = bytearray()
        async for chunk in self.stream:
            if body is not None:
                if len(body) + len(chunk) <= 65536:
                    body.extend(chunk)
                else:
                    body = None
            yield chunk
        if body is not None:
            try:
                data = json.loads(body)
                if isinstance(data, dict):
                    self.budget.response_receipt(self.call_id, data)
                    self.budget.settle(self.call_id, 'succeeded', self.status)
            except (ValueError, TypeError):
                pass  # Invalid/incomplete bodies remain unknown and block reuse.

    async def aclose(self):
        await self.stream.aclose()


def install_async(budget: Budget):
    """Apply the same durable allowance to non-streaming async life requests."""
    original = httpx.AsyncClient.send

    async def send(client, request, **kwargs):
        if request.method != 'POST':
            return await original(client, request, **kwargs)
        try:
            if json.loads(request.content).get('stream'):
                raise ValueError('async_stream_not_authorized')
        except (ValueError, TypeError, AttributeError):
            raise httpx.RequestError('本轮未授权异步流式模型调用', request=request) from None
        request, payload, call_id = prepare_request(budget, request)
        response = await original(client, request, **kwargs)
        if response.status_code >= 400:
            budget.settle(call_id, 'failed', response.status_code)
        elif response.is_stream_consumed:
            try:
                data = response.json()
                if isinstance(data, dict):
                    budget.response_receipt(call_id, data)
            except (ValueError, TypeError):
                pass
            budget.settle(call_id, 'succeeded', response.status_code)
        elif kwargs.get('stream'):
            # HTTP chunked reading does not imply a streaming model response.
            response.stream = GuardedAsyncBody(response.stream, budget, call_id, response.status_code)
        return response

    httpx.AsyncClient.send = send
    return original
