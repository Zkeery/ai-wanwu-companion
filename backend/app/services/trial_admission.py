"""Pure admission checks. A token counter or a zero bill is not a cash proof."""
from app.services.trial_gate import TrialBlocked, PROFILES, PRICE_CAPS, integer


def validate_evidence(evidence, ref, kinds, now, required):
    """Validate the whole reservation before any directory/ledger/business write.

    pending_complete means the source includes unbilled and unsettled liability,
    not merely the console's posted-unsettled field. Unknown stays blocked.
    The caller must supply fresh official evidence; this function cannot refresh it.
    """
    try:
        expiry, accounts = [], {}
        for kind in kinds:
            vendor, model, _ = PROFILES[kind]
            value = evidence[kind]
            wallet, price = value['wallet'], value['price']
            for record in (wallet, price):
                assert record['verified'] is True
                assert record['authorization_ref'] == ref
                assert record['vendor'] == vendor and record['currency'] == 'CNY'
                assert integer(record['checked_at']) and 0 <= now - record['checked_at'] <= 900
                expiry.append(record['checked_at'] + 900)
            assert wallet['pending_complete'] is True
            assert wallet['source_type'] in ('official_console', 'official_api')
            assert isinstance(wallet['account'], str) and 0 < len(wallet['account']) <= 128
            assert integer(wallet['available_micro']) and integer(wallet['pending_micro'])
            assert wallet['available_micro'] - wallet['pending_micro'] >= required[vendor]
            assert price['model'] == model and price['on_sale'] is True
            assert set(price['rates']) == set(PRICE_CAPS[vendor])
            assert all(integer(v) and v <= PRICE_CAPS[vendor][k] for k, v in price['rates'].items())
            # Private/shared must cite exactly the same wallet, not two balances
            # that are each large enough for only part of the reservation.
            if vendor in accounts:
                assert accounts[vendor] == wallet
            accounts[vendor] = wallet
        return {'expires_at': min(expiry), 'accounts': {k: v['account'] for k, v in accounts.items()}}
    except (AssertionError, KeyError, TypeError, ValueError):
        raise TrialBlocked('complete_funds_or_current_price_required') from None


def live_evidence_reader(path, gate, *, clock):
    """Refresh from the private proof file on every dispatch; never restamp it."""
    from app.services.accounting_proof_refresh import read_published
    def read(kind):
        evidence = read_published(path, gate.policy['authorization_ref'])
        validate_evidence(evidence, gate.policy['authorization_ref'],
                          ('private_life', 'shared_life'), int(clock()), {'maas': 6873600})
        return evidence[kind]
    return read


def shared_dialogue_evidence_reader(path, gate, *, clock):
    """Independent one-round proof; never accepts the old two-scope life proof."""
    from app.services.accounting_proof_refresh import read_published
    def read(kind):
        if gate.policy['mode'] != 'shared_dialogue' or kind != 'shared_life':
            raise TrialBlocked('scope_mismatch')
        evidence = read_published(path, gate.policy['authorization_ref'])
        if not isinstance(evidence, dict) or set(evidence) != {'shared_life'}:
            raise TrialBlocked('single_round_financial_proof_required')
        admission = validate_evidence(evidence, gate.policy['authorization_ref'], ('shared_life',),
                                      int(clock()), {'maas': PROFILES['shared_life'][2]})
        if gate.policy['ends_at'] > admission['expires_at']:
            raise TrialBlocked('trial_exceeds_financial_proof')
        return evidence[kind]
    return read


def validate_shared_dialogue_approval(policy, evidence, now):
    """Pure one-round admission before quota, ledger, grant or directory writes."""
    from app.services.trial_gate import validate_policy
    validate_policy(policy)
    if (policy['mode'] != 'shared_dialogue' or not isinstance(evidence, dict)
            or set(evidence) != {'shared_life'} or not policy['starts_at'] <= now < policy['ends_at']):
        raise TrialBlocked('independent_shared_approval_required')
    admission = validate_evidence(evidence, policy['authorization_ref'], ('shared_life',),
                                  now, {'maas': PROFILES['shared_life'][2]})
    if policy['ends_at'] > admission['expires_at']:
        raise TrialBlocked('trial_exceeds_financial_proof')
    return admission


def bounded_shared_dialogue_grant(gate, store, evidence_path, *, create=False):
    """Trusted maintenance only. Check by default; never opens flags or consent.

    Creation binds the business grant to the already approved owner/space/pair
    and its deadline to the independent policy and original financial proof.
    """
    reader = shared_dialogue_evidence_reader(evidence_path, gate, clock=gate.clock)
    gate.preflight_evidence(reader)
    policy = gate.policy
    scope, ids = policy['scopes']['shared_life'], policy['character_ids']
    with store.engine.connect() as conn:
        group, _ = store.load(conn, scope['subject'])
        store.facts(conn, group, scope['owner'], ids)
    result = dict(status='checked', grant_created=False, expires_at=policy['ends_at'],
                  reserved_micro=PROFILES['shared_life'][2], new_model_posts=0,
                  flags_changed=False, worker_started=False)
    if create:
        result['grant_id'] = store.authorize(scope['owner'], scope['subject'], ids,
                                            policy['authorization_ref'], expires_at=policy['ends_at'])
        result.update(status='prepared_not_started', grant_created=True)
    return result
