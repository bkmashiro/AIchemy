from __future__ import annotations

import pytest

from alchemy_sdk.experiment import Experiment


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
