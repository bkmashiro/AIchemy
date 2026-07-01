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
