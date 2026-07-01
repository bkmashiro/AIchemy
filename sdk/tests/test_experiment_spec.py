from __future__ import annotations

import builtins

import pytest

from alchemy_sdk.experiment import Experiment


def test_experiment_code_id_is_explicit_human_reference_in_spec():
    spec = Experiment(
        code_id="jema.atari.coverage500.v1",
        name="Atari coverage500",
        family="jema-atari-parametric",
    ).to_spec()

    assert spec["code_id"] == "jema.atari.coverage500.v1"
    assert spec["name"] == "Atari coverage500"
    assert spec["family"] == "jema-atari-parametric"


def test_experiment_code_id_rejects_empty_values():
    with pytest.raises(ValueError, match="code_id"):
        Experiment(code_id=" ", name="bad")


def test_storage_root_is_in_experiment_spec():
    spec = Experiment("x").storage(root="/runs").to_spec()

    assert spec["storage"] == {"root": "/runs"}


def test_storage_accepts_optional_artifact_root_and_is_chainable():
    exp = Experiment("x")

    returned = exp.storage(root="/runs", artifact_root="/artifacts")

    assert returned is exp
    assert exp.to_spec()["storage"] == {
        "root": "/runs",
        "artifact_root": "/artifacts",
    }


def test_storage_rejects_empty_paths():
    exp = Experiment("x")

    with pytest.raises(ValueError, match="storage root"):
        exp.storage(root="")

    with pytest.raises(ValueError, match="artifact_root"):
        exp.storage(root="/runs", artifact_root="  ")


def test_to_spec_returns_defensive_storage_copy():
    exp = Experiment("x").storage(root="/runs", artifact_root="/artifacts")

    spec = exp.to_spec()
    spec["storage"]["root"] = "/mutated"

    assert exp.to_spec()["storage"]["root"] == "/runs"


def test_base_config_is_chainable_and_defensively_copied():
    config = {"train": {"batch_size": 64}}
    exp = Experiment("x")

    returned = exp.base_config(config)
    config["train"]["batch_size"] = 128

    assert returned is exp
    assert exp.to_spec()["config"] == {"train": {"batch_size": 64}}


def test_to_spec_returns_defensive_config_copy_for_base_config_and_legacy_assignment():
    exp = Experiment("x").base_config({"train": {"lr": 1e-4}})

    spec = exp.to_spec()
    spec["config"]["train"]["lr"] = 3e-4

    assert exp.to_spec()["config"] == {"train": {"lr": 1e-4}}

    legacy = Experiment("legacy")
    legacy.config = {"train": {"lr": 2e-4}}
    legacy_spec = legacy.to_spec()
    legacy_spec["config"]["train"]["lr"] = 9e-4

    assert legacy.to_spec()["config"] == {"train": {"lr": 2e-4}}


def test_to_spec_includes_sdk_metadata_snapshot():
    spec = Experiment("x").to_spec()

    assert spec["metadata"]["sdk_version"] == "2.1.0"
    assert "cwd" in spec["metadata"]
    assert "git_commit" in spec["metadata"]


def test_dry_run_validates_and_returns_spec_without_submit_import(monkeypatch):
    real_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "alchemy_sdk.submit":
            raise AssertionError("dry_run must not import submit_experiment")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)

    exp = (
        Experiment("dry", family="sdk")
        .storage(root="/runs")
        .base_config({"train": {"batch_size": 64}})
    )
    exp.task("train", script="train.py")

    spec = exp.dry_run()

    assert spec["name"] == "dry"
    assert spec["family"] == "sdk"
    assert spec["storage"] == {"root": "/runs"}
    assert spec["config"] == {"train": {"batch_size": 64}}
    assert spec["tasks"] == [{"ref": "train", "script": "train.py"}]


def test_dry_run_reuses_dag_validation():
    exp = Experiment("bad")

    with pytest.raises(ValueError, match="no tasks"):
        exp.dry_run()

    train = exp.task("train", script="train.py")
    train._spec["depends_on"] = ["missing"]

    with pytest.raises(ValueError, match="depends on unknown ref"):
        exp.dry_run()


def test_dry_run_includes_empty_warnings_for_clean_storage():
    exp = Experiment("clean").storage(root="/vol/gpudata/runs")
    exp.task("train", script="train.py", cwd="/tmp/project")

    dry = exp.dry_run()

    assert dry["warnings"] == []


def test_dry_run_warns_about_bitbucket_paths_without_explicit_storage():
    exp = Experiment("legacy")
    exp.task("train", script="train.py", cwd="/vol/bitbucket/ys25/jema-v2")

    dry = exp.dry_run()

    assert dry["warnings"] == [
        {
            "code": "bitbucket_storage_without_root",
            "message": "Task 'train' references /vol/bitbucket without explicit experiment storage root",
            "ref": "train",
            "field": "cwd",
            "path": "/vol/bitbucket/ys25/jema-v2",
        }
    ]


def test_dry_run_warns_when_grid_has_no_storage_root():
    exp = Experiment("grid").params(seed=[1, 2])
    exp.task("train-{seed}", script="train.py")

    dry = exp.dry_run()
    assert dry["warnings"] == [
        {
            "code": "grid_without_storage_root",
            "message": "Grid experiment has no explicit experiment storage root",
        }
    ]


def test_task_metric_schema_appears_in_spec():
    exp = Experiment("metrics")
    exp.task("train", script="train.py", metrics={"loss": "min", "retrieval_at5": "max"})

    task = exp.to_spec()["tasks"][0]

    assert task["metric_schema"] == {"loss": "min", "retrieval_at5": "max"}


def test_task_metric_schema_rejects_invalid_direction():
    exp = Experiment("metrics")

    with pytest.raises(ValueError, match="metric direction"):
        exp.task("train", script="train.py", metrics={"loss": "down"})


def test_task_metric_schema_is_defensively_copied():
    metrics = {"loss": "min"}
    exp = Experiment("metrics")
    exp.task("train", script="train.py", metrics=metrics)
    metrics["loss"] = "max"

    spec = exp.to_spec()
    spec["tasks"][0]["metric_schema"]["loss"] = "max"

    assert exp.to_spec()["tasks"][0]["metric_schema"] == {"loss": "min"}
