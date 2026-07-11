from __future__ import annotations

import builtins

import pytest

from alchemy_sdk.experiment import Experiment, RuntimeProfile


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


def test_runtime_profile_materializes_shared_execution_environment():
    profile = RuntimeProfile(
        name="jema-v3-a30",
        cwd="/vol/bitbucket/ys25/jema-v3",
        python_env="/vol/bitbucket/ys25/conda-envs/jema",
        env={
            "PYTHONPATH": "/vol/bitbucket/ys25/jema-v3/src:/vol/bitbucket/ys25/alchemy-v2/sdk",
        },
    )
    exp = Experiment("runtime").runtime(profile)
    exp.task("train", script="scripts/train.py", env={"CUBLAS_WORKSPACE_CONFIG": ":4096:8"})

    spec = exp.to_spec()

    assert spec["runtime"] == {
        "name": "jema-v3-a30",
        "cwd": "/vol/bitbucket/ys25/jema-v3",
        "python_env": "/vol/bitbucket/ys25/conda-envs/jema",
        "env": {
            "PYTHONPATH": "/vol/bitbucket/ys25/jema-v3/src:/vol/bitbucket/ys25/alchemy-v2/sdk",
        },
    }
    assert spec["tasks"] == [
        {
            "ref": "train",
            "script": "scripts/train.py",
            "cwd": "/vol/bitbucket/ys25/jema-v3",
            "python_env": "/vol/bitbucket/ys25/conda-envs/jema",
            "env": {
                "PYTHONPATH": "/vol/bitbucket/ys25/jema-v3/src:/vol/bitbucket/ys25/alchemy-v2/sdk",
                "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
            },
        }
    ]


def test_task_values_override_runtime_profile_without_mutating_it():
    profile = RuntimeProfile(
        name="base",
        cwd="/base",
        python_env="/base/python",
        env={"MODE": "base", "KEEP": "yes"},
    )
    exp = Experiment("runtime").runtime(profile)
    exp.task(
        "train",
        script="train.py",
        cwd="/task",
        python_env="/task/python",
        env={"MODE": "task"},
    )

    task = exp.to_spec()["tasks"][0]

    assert task["cwd"] == "/task"
    assert task["python_env"] == "/task/python"
    assert task["env"] == {"MODE": "task", "KEEP": "yes"}
    assert profile.env == {"MODE": "base", "KEEP": "yes"}


def test_decision_policy_is_declared_in_spec_and_chainable():
    exp = Experiment("policy")

    returned = exp.decision_policy(
        primary_metric="score",
        direction="max",
        keep_if="mean(score) >= 0.8",
        try_more_if="0.6 <= mean(score) < 0.8",
        discard_if="mean(score) < 0.6",
        min_seeds=3,
    )

    assert returned is exp
    assert exp.to_spec()["decision_policy"] == {
        "primary_metric": "score",
        "direction": "max",
        "keep_if": "mean(score) >= 0.8",
        "try_more_if": "0.6 <= mean(score) < 0.8",
        "discard_if": "mean(score) < 0.6",
        "min_seeds": 3,
    }


def test_dry_run_validates_decision_policy_metric_is_declared():
    exp = Experiment("policy").decision_policy(primary_metric="score", direction="max")
    exp.task("train", script="train.py", metrics={"loss": "min"})

    with pytest.raises(ValueError, match="decision_policy primary_metric"):
        exp.dry_run()


def test_dry_run_accepts_decision_policy_metric_from_task_schema():
    exp = Experiment("policy").decision_policy(primary_metric="score", direction="max")
    exp.task("eval", script="eval.py", metrics={"score": "max"})

    assert exp.dry_run()["decision_policy"]["primary_metric"] == "score"


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


def test_task_target_stub_id_appears_in_spec():
    exp = Experiment("targeted")
    exp.task("train", script="/vol/bitbucket/ys25/conda-envs/jema/bin/python", target_stub_id="stub-a")

    assert exp.to_spec()["tasks"][0]["target_stub_id"] == "stub-a"


def test_dry_run_warns_when_cluster_py_script_would_use_default_python():
    exp = Experiment("plain-python")
    exp.task(
        "train",
        script="/vol/bitbucket/ys25/jspace-workspace-regularization/scripts/run_synthetic.py",
    )

    warnings = exp.dry_run()["warnings"]

    assert any(w["code"] == "python_script_uses_default_python" for w in warnings)
    warning = next(w for w in warnings if w["code"] == "python_script_uses_default_python")
    assert warning["ref"] == "train"
    assert "plain `python`" in warning["message"]


def test_dry_run_warns_explicit_high_priority_without_routing():
    exp = Experiment("priority")
    exp.task("train", script="/bin/bash", raw_args="-lc true", priority=6)

    warnings = exp.dry_run()["warnings"]

    assert any(w["code"] == "high_priority_unrouted" for w in warnings)
    warning = next(w for w in warnings if w["code"] == "high_priority_unrouted")
    assert warning["ref"] == "train"
    assert "priority sorts descending" in warning["message"]


def test_dry_run_warns_gpu_work_without_memory_reservation():
    exp = Experiment("gpu-reservation")
    exp.task("train", script="/bin/python", requirements={"gpu_type": ["A30"]})

    warnings = exp.dry_run()["warnings"]

    warning = next(w for w in warnings if w["code"] == "gpu_memory_unreserved")
    assert warning["ref"] == "train"
    assert warning["field"] == "requirements.gpu_mem_mb"


def test_dry_run_accepts_explicit_exclusive_gpu_without_memory_reservation():
    exp = Experiment("gpu-exclusive")
    exp.task(
        "train",
        script="/bin/python",
        requirements={"gpu_type": ["A30"], "exclusive_gpu": True},
    )

    warnings = exp.dry_run()["warnings"]

    assert not any(w["code"] == "gpu_memory_unreserved" for w in warnings)


def test_dry_run_warns_non_positive_resource_requirement():
    exp = Experiment("invalid-resource")
    exp.task("train", script="/bin/python", requirements={"cpu_mem_mb": 0})

    warnings = exp.dry_run()["warnings"]

    warning = next(w for w in warnings if w["code"] == "invalid_resource_requirement")
    assert warning["field"] == "requirements.cpu_mem_mb"


def test_dry_run_warns_duplicate_relative_output_args():
    exp = Experiment("output-collision")
    exp.task("seed0", script="/bin/python", raw_args="train.py --output results/synthetic_seed0.json")
    exp.task("seed1", script="/bin/python", raw_args="train.py --output results/synthetic_seed0.json")

    warnings = exp.dry_run()["warnings"]

    assert any(w["code"] == "duplicate_relative_output" for w in warnings)
    warning = next(w for w in warnings if w["code"] == "duplicate_relative_output")
    assert warning["path"] == "results/synthetic_seed0.json"
    assert warning["refs"] == ["seed0", "seed1"]


def test_dry_run_allows_task_output_also_present_in_raw_args():
    exp = Experiment("declared-output")
    exp.task(
        "eval",
        script="/bin/python",
        raw_args="eval.py --output results/eval.json",
        outputs=["results/eval.json"],
    )

    warnings = exp.dry_run()["warnings"]

    assert not any(w["code"] == "duplicate_relative_output" for w in warnings)
