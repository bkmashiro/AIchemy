from __future__ import annotations

import pytest

from alchemy_sdk.experiment import Experiment


def test_params_expand_deterministic_param_points_in_declaration_order():
    spec = Experiment("grid").params(seed=[1, 2], lr=[0.1, 0.2]).to_spec()

    assert spec["param_space"] == {"seed": [1, 2], "lr": [0.1, 0.2]}
    assert spec["param_points"] == [
        {"seed": 1, "lr": 0.1},
        {"seed": 1, "lr": 0.2},
        {"seed": 2, "lr": 0.1},
        {"seed": 2, "lr": 0.2},
    ]


def test_params_reject_empty_lists_and_scalars():
    with pytest.raises(ValueError, match="non-empty"):
        Experiment("grid").params(seed=[])

    with pytest.raises(ValueError, match="list or tuple"):
        Experiment("grid").params(seed=1)


def test_params_are_defensively_copied():
    seeds = [1, 2]
    exp = Experiment("grid").params(seed=seeds)
    seeds.append(3)

    spec = exp.to_spec()
    spec["param_space"]["seed"].append(4)
    spec["param_points"][0]["seed"] = 99

    assert exp.to_spec()["param_space"] == {"seed": [1, 2]}
    assert exp.to_spec()["param_points"] == [{"seed": 1}, {"seed": 2}]
