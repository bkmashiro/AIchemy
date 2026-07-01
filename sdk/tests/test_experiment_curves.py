from __future__ import annotations

from alchemy_sdk.experiments import ExperimentClient


def test_curves_fetches_task_metrics_by_ref_and_param_filter(monkeypatch):
    client = ExperimentClient(server="http://alchemy.local", token="tok")
    experiment = {
        "id": "exp-1",
        "name": "grid",
        "task_refs": {"train-1": "task-1", "train-2": "task-2"},
        "task_specs": [
            {"ref": "train-1", "ref_template": "train-{seed}", "param_point": {"seed": 1}},
            {"ref": "train-2", "ref_template": "train-{seed}", "param_point": {"seed": 2}},
        ],
    }
    monkeypatch.setattr(client, "list", lambda **_: [experiment])

    calls = []

    def fake_get(path):
        calls.append(path)
        return {
            "task_id": "task-1",
            "metrics_buffer": {
                "loss": [{"step": 1, "value": 0.9}, {"step": 2, "value": 0.7}],
                "acc": [{"step": 1, "value": 0.1}],
            },
            "points": [],
        }

    monkeypatch.setattr(client, "_get", fake_get)

    curves = client.curves("grid", metric="loss", params={"seed": 1})

    assert calls == ["/tasks/task-1/metrics"]
    assert curves == {
        "experiment_id": "exp-1",
        "source": "ring_buffer",
        "curves": {
            "train-1": {
                "task_id": "task-1",
                "params": {"seed": 1},
                "metrics": {"loss": [{"step": 1, "value": 0.9}, {"step": 2, "value": 0.7}]},
            }
        },
    }


def test_curves_uses_legacy_points_when_metrics_buffer_missing(monkeypatch):
    client = ExperimentClient(server="http://alchemy.local", token="tok")
    experiment = {
        "id": "exp-1",
        "name": "single",
        "task_refs": {"train": "task-1"},
        "task_specs": [{"ref": "train"}],
    }
    monkeypatch.setattr(client, "list", lambda **_: [experiment])
    monkeypatch.setattr(client, "_get", lambda path: {"task_id": "task-1", "points": [{"step": 1, "loss": 0.5}]})

    curves = client.curves("single")

    assert curves["curves"]["train"]["metrics"] == {"legacy": [{"step": 1, "loss": 0.5}]}
