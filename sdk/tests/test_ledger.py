from __future__ import annotations

from alchemy_sdk.ledger import append_comment, append_decision, ledger_hash, parse_ledger, render_ledger_block, replace_ledger


def test_ledger_block_roundtrips_and_hash_is_stable():
    ledger = {
        "decisions": [{"id": "keep-baseline", "decision": "keep", "reason": "best score"}],
        "notes": [],
        "evidence": [{"ref": "jema.atari.coverage500.v1", "kind": "experiment"}],
    }
    text = "before\n" + render_ledger_block(ledger) + "\nafter\n"

    parsed = parse_ledger(text)

    assert parsed == ledger
    assert ledger_hash(parsed) == ledger_hash(parsed)


def test_replace_ledger_is_idempotent_and_preserves_outer_code():
    text = "print('before')\n" + render_ledger_block({"decisions": [], "notes": [], "evidence": []}) + "\nprint('after')\n"
    updated = replace_ledger(text, {"decisions": [{"id": "d1", "decision": "keep"}], "notes": [], "evidence": []})
    updated_again = replace_ledger(updated, {"decisions": [{"id": "d1", "decision": "keep"}], "notes": [], "evidence": []})

    assert updated == updated_again
    assert updated.startswith("print('before')")
    assert updated.rstrip().endswith("print('after')")
    assert parse_ledger(updated)["decisions"] == [{"id": "d1", "decision": "keep"}]


def test_append_decision_is_idempotent_by_id():
    ledger = {"decisions": [], "notes": [], "evidence": []}

    once = append_decision(ledger, decision_id="d1", decision="keep", reason="good")
    twice = append_decision(once, decision_id="d1", decision="keep", reason="good")

    assert twice["decisions"] == [{"id": "d1", "decision": "keep", "reason": "good"}]


def test_append_comment_is_idempotent_by_id_and_tracks_evidence():
    ledger = {"decisions": [], "notes": [], "evidence": []}

    once = append_comment(
        ledger,
        comment_id="freeway-coverage",
        comment="Freeway coverage still zero",
        evidence=["task:abc"],
    )
    twice = append_comment(
        once,
        comment_id="freeway-coverage",
        comment="changed text should not duplicate",
        evidence=["task:abc"],
    )

    assert twice["notes"] == [
        {"id": "freeway-coverage", "comment": "Freeway coverage still zero", "evidence": ["task:abc"]}
    ]
    assert twice["evidence"] == [{"ref": "task:abc", "kind": "experiment"}]
