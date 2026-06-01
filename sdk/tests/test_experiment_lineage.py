from alchemy_sdk.experiment import Experiment


def test_experiment_accepts_intent_fields_and_submit_payload(monkeypatch):
    captured = {}

    def fake_submit_experiment(**kwargs):
        captured.update(kwargs)
        from alchemy_sdk.experiment import ExperimentResult
        return ExperimentResult(
            experiment_id="exp-1",
            task_refs={"train": "task-1"},
            already_exists=False,
            url="http://server/experiments/exp-1",
        )

    monkeypatch.setattr("alchemy_sdk.submit.submit_experiment", fake_submit_experiment)

    exp = Experiment(
        "curiosity_s42",
        server="http://server",
        family="pretrain_nh",
        hypothesis="curiosity improves zn",
        expected_outcome="zn up, loss stable",
    )
    exp.task("train", script="train.py")
    exp.submit()

    assert captured["family"] == "pretrain_nh"
    assert captured["hypothesis"] == "curiosity improves zn"
    assert captured["expected_outcome"] == "zn up, loss stable"


def test_fork_reason_is_submitted(monkeypatch):
    captured = {}

    def fake_submit_experiment(**kwargs):
        captured.update(kwargs)
        from alchemy_sdk.experiment import ExperimentResult
        return ExperimentResult(
            experiment_id="exp-child",
            task_refs={"train": "task-child"},
            already_exists=False,
            url="http://server/experiments/exp-child",
        )

    monkeypatch.setattr("alchemy_sdk.submit.submit_experiment", fake_submit_experiment)

    base = Experiment("baseline", server="http://server", family="pretrain_nh")
    base.config = {"train": {"lr": 3e-4}}
    base.task("train", script="train.py")

    child = base.fork("curiosity_s42", reason="baseline plateaued")
    child.config["train"]["lr"] = 1e-4
    child.submit()

    assert captured["parent_name"] == "baseline"
    assert captured["family"] == "pretrain_nh"
    assert captured["fork_reason"] == "baseline plateaued"
    assert captured["config_diff"] == {"train.lr": {"old": 3e-4, "new": 1e-4}}
