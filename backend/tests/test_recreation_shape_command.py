import json

import pytest

from scripts import run_recreation_shape as command


def test_split_sse_and_required_terminal_structure():
    rows=['event: started','data: {"character_id":8}','','event: done','data: {"id":8}','','']
    assert list(command.events(iter(rows)))==[('started',{'character_id':8}),('done',{'id':8})]
    with pytest.raises(ValueError):list(command.events(['event: done','data: {"id":8}']))


@pytest.mark.parametrize('change',[{'paused':True},{'authorized':False},{'requests':10},{'reserved_cny':4.0}])
def test_cannot_start_without_two_requests_and_existing_reserve(monkeypatch,change):
    class Budget:
        reference='real-web-recovery-20261002-4.8cny-11requests'
        def status(self):
            return dict(authorized=True,paused=False,requests=5,requests_max=11,
                reserved_cny=2.5232,budget_cny=4.8,**{})|change
    monkeypatch.setattr(command,'selected',lambda *_:Budget())
    with pytest.raises(ValueError):command.checked_budget()


def test_submitted_or_started_revision_cannot_resend(monkeypatch,tmp_path):
    state=tmp_path/'state.json';state.write_text(json.dumps({'status':'started','request_id':'fixed'}))
    monkeypatch.setattr(command,'STATE',state);monkeypatch.setattr(command,'RUN',tmp_path)
    monkeypatch.setattr(command.httpx,'Client',lambda *_a,**_kw:pytest.fail('No API replay'))
    with pytest.raises(ValueError):command.run()
    state.write_text(json.dumps({'status':'prepared','request_id':'fixed'}));(tmp_path/'submitted.json').write_text('{}')
    with pytest.raises(FileExistsError):command.run()
