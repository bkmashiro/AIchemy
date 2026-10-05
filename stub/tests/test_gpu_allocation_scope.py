from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from alchemy_stub.gpu_monitor import GpuMonitor


def _monitor(env: dict[str, str]) -> GpuMonitor:
    with patch.dict("os.environ", env, clear=True), patch.object(GpuMonitor, "_check_available", return_value=True):
        return GpuMonitor()


def _smi_result(rows: str) -> MagicMock:
    result = MagicMock()
    result.returncode = 0
    result.stdout = rows
    return result


def test_filters_uuid_scoped_slurm_telemetry_and_capacity_to_visible_devices():
    monitor = _monitor({
        "SLURM_JOB_ID": "100",
        "SLURM_JOB_GPUS": "GPU-a,GPU-b",
        "CUDA_VISIBLE_DEVICES": "GPU-a",
    })
    rows = (
        "0, Tesla A100, 20, 100, 40000, 50, GPU-a\n"
        "1, Tesla A100, 90, 9000, 40000, 80, GPU-b"
    )
    with patch("subprocess.run", side_effect=[
        _smi_result("0, GPU-a, Tesla A100, 40000"),
        _smi_result(rows),
    ]):
        info = monitor.get_gpu_info()
        stats = monitor.query()

    assert info == {"name": "Tesla A100", "vram_total_mb": 40000, "count": 1, "allocation_known": True}
    assert stats["allocation_known"] is True
    assert [gpu["index"] for gpu in stats["gpus"]] == [0]
    assert stats["gpus"][0]["memory_used_mb"] == 100


def test_disjoint_job_uuid_sets_do_not_report_the_other_job_gpu():
    first = _monitor({"SLURM_JOB_ID": "100", "SLURM_JOB_GPUS": "GPU-a", "CUDA_VISIBLE_DEVICES": "GPU-a"})
    second = _monitor({"SLURM_JOB_ID": "101", "SLURM_JOB_GPUS": "GPU-b", "CUDA_VISIBLE_DEVICES": "GPU-b"})
    rows = "0, Tesla A100, 10, 100, 40000, 50, GPU-a\n1, Tesla A100, 90, 9000, 40000, 80, GPU-b"
    with patch("subprocess.run", return_value=_smi_result(rows)):
        assert [g["index"] for g in first.query()["gpus"]] == [0]
    with patch("subprocess.run", return_value=_smi_result(rows)):
        assert [g["index"] for g in second.query()["gpus"]] == [1]


def test_empty_slurm_visibility_is_known_empty_not_host_gpu_capacity():
    monitor = _monitor({"SLURM_JOB_ID": "100", "SLURM_JOB_GPUS": "GPU-a", "CUDA_VISIBLE_DEVICES": ""})
    with patch("subprocess.run", return_value=_smi_result("0, Tesla A100, 10, 100, 40000, 50, GPU-a")):
        assert monitor.get_gpu_info() == {"name": "Unknown GPU allocation", "vram_total_mb": 0, "count": 0, "allocation_known": True}
        assert monitor.query()["gpus"] == []


def test_ambiguous_numeric_mapping_fails_closed_instead_of_assuming_cuda_zero_is_host_zero():
    monitor = _monitor({"SLURM_JOB_ID": "100", "SLURM_JOB_GPUS": "3", "CUDA_VISIBLE_DEVICES": "0"})
    with patch("subprocess.run", return_value=_smi_result("0, Tesla A100, 10, 100, 40000, 50, GPU-a")):
        assert monitor.get_gpu_info() == {"name": "Unknown GPU allocation", "vram_total_mb": 0, "count": 0, "allocation_known": False}
        assert monitor.query()["gpus"] == []
        assert monitor.query()["allocation_known"] is False


def test_numeric_mapping_is_used_only_when_slurm_job_gpu_ids_match_exactly():
    monitor = _monitor({"SLURM_JOB_ID": "100", "SLURM_JOB_GPUS": "3", "CUDA_VISIBLE_DEVICES": "3"})
    with patch("subprocess.run", return_value=_smi_result("3, Tesla A100, 10, 100, 40000, 50, GPU-a")):
        stats = monitor.query()
    assert stats["allocation_known"] is True
    assert [gpu["index"] for gpu in stats["gpus"]] == [3]


def test_cuda_driver_uuid_resolves_slurm_physical_id_to_visible_nvidia_row():
    monitor = _monitor({"SLURM_JOB_ID": "295565", "SLURM_JOB_GPUS": "5", "CUDA_VISIBLE_DEVICES": "0"})
    rows = (
        "0, Tesla T4, 18, 1024, 15360, 55, GPU-beee25a6-aab2-c31e-a92d-bdde9057629a\n"
        "5, Tesla T4, 91, 9000, 15360, 80, GPU-00026566-97c5-d6d4-e283-cbcfa08bec7b"
    )
    with patch.object(monitor, "_resolve_visible_cuda_uuids", return_value={
        "GPU-00026566-97c5-d6d4-e283-cbcfa08bec7b"
    }), patch("subprocess.run", return_value=_smi_result(rows)):
        stats = monitor.query()

    assert stats["allocation_known"] is True
    assert [gpu["index"] for gpu in stats["gpus"]] == [5]
    assert stats["gpus"][0]["memory_used_mb"] == 9000


def test_numeric_cuda_uuid_partial_or_missing_nvidia_row_is_unknown():
    monitor = _monitor({"SLURM_JOB_ID": "295565", "SLURM_JOB_GPUS": "5", "CUDA_VISIBLE_DEVICES": "0"})
    with patch.object(monitor, "_resolve_visible_cuda_uuids", return_value={"GPU-requested"}), patch(
        "subprocess.run", return_value=_smi_result("0, Tesla T4, 10, 100, 15360, 50, GPU-other")
    ):
        stats = monitor.query()
    assert stats["gpus"] == []
    assert stats["allocation_known"] is False


def test_numeric_cuda_uuid_resolution_failure_is_unknown_unless_exact_legacy_mapping():
    monitor = _monitor({"SLURM_JOB_ID": "100", "SLURM_JOB_GPUS": "5", "CUDA_VISIBLE_DEVICES": "0"})
    with patch.object(monitor, "_resolve_visible_cuda_uuids", return_value=None), patch(
        "subprocess.run", return_value=_smi_result("5, Tesla T4, 10, 100, 15360, 50, GPU-a")
    ):
        stats = monitor.query()
    assert stats["gpus"] == []
    assert stats["allocation_known"] is False


def test_partial_uuid_match_marks_registration_scope_unknown():
    monitor = _monitor({
        "SLURM_JOB_ID": "100",
        "CUDA_VISIBLE_DEVICES": "GPU-a,GPU-b",
    })
    with patch("subprocess.run", return_value=_smi_result("0, GPU-a, Tesla A100, 40000")):
        info = monitor.get_gpu_info()
    assert info["count"] == 1
    assert info["allocation_known"] is False


def test_partial_or_empty_tick_is_not_a_known_allocation_sample():
    monitor = _monitor({
        "SLURM_JOB_ID": "100",
        "CUDA_VISIBLE_DEVICES": "GPU-a,GPU-b",
    })
    with patch("subprocess.run", return_value=_smi_result(
        "0, Tesla A100, 10, 100, 40000, 50, GPU-a"
    )):
        stats = monitor.query()
    assert [gpu["index"] for gpu in stats["gpus"]] == [0]
    assert stats["allocation_known"] is False

    with patch("subprocess.run", return_value=_smi_result("")):
        empty = monitor.query()
    assert empty["gpus"] == []
    assert empty["allocation_known"] is False


def test_failed_gpu_queries_mark_slurm_registration_and_tick_unknown():
    monitor = _monitor({
        "SLURM_JOB_ID": "100",
        "CUDA_VISIBLE_DEVICES": "GPU-a",
    })
    failed = _smi_result("")
    failed.returncode = 1
    with patch("subprocess.run", return_value=failed):
        info = monitor.get_gpu_info()
    assert info["allocation_known"] is False

    with patch("subprocess.run", side_effect=RuntimeError("query unavailable")):
        stats = monitor.query()
    assert stats["gpus"] == []
    assert stats["allocation_known"] is False


def test_unavailable_slurm_telemetry_does_not_claim_allocation_known():
    with patch.dict("os.environ", {
        "SLURM_JOB_ID": "100",
        "CUDA_VISIBLE_DEVICES": "GPU-a",
    }, clear=True), patch.object(GpuMonitor, "_check_available", return_value=False):
        monitor = GpuMonitor()
    assert monitor.get_gpu_info()["allocation_known"] is False
    assert monitor.query()["allocation_known"] is False


def test_mig_uuid_mapping_is_unknown_when_only_physical_gpu_rows_are_available():
    monitor = _monitor({"SLURM_JOB_ID": "100", "SLURM_JOB_GPUS": "GPU-a", "CUDA_VISIBLE_DEVICES": "MIG-GPU-a/1/0"})
    with patch("subprocess.run", return_value=_smi_result("0, Tesla A100, 10, 100, 40000, 50, GPU-a")):
        assert monitor.get_gpu_info()["allocation_known"] is False
        assert monitor.query()["gpus"] == []


def test_non_slurm_keeps_unfiltered_host_behavior():
    monitor = _monitor({})
    with patch("subprocess.run", side_effect=[
        _smi_result("0, GPU-a, Tesla A100, 40000"),
        _smi_result("0, Tesla A100, 10, 100, 40000, 50, GPU-a"),
    ]):
        assert monitor.get_gpu_info() == {"name": "Tesla A100", "vram_total_mb": 40000, "count": 1, "allocation_known": True}
        assert len(monitor.query()["gpus"]) == 1


def test_cuda_driver_library_and_init_failures_are_unknown():
    monitor = _monitor({"SLURM_JOB_ID": "295565", "SLURM_JOB_GPUS": "5", "CUDA_VISIBLE_DEVICES": "0"})
    with patch("alchemy_stub.gpu_monitor.ctypes.util.find_library", return_value=None):
        assert monitor._allocation_scope() == (set(), False)

    monitor = _monitor({"SLURM_JOB_ID": "295565", "SLURM_JOB_GPUS": "5", "CUDA_VISIBLE_DEVICES": "0"})
    driver = SimpleNamespace(
        cuInit=MagicMock(return_value=1),
        cuDeviceGetCount=MagicMock(),
        cuDeviceGet=MagicMock(),
        cuDeviceGetUuid=MagicMock(),
    )
    with patch("alchemy_stub.gpu_monitor.ctypes.util.find_library", return_value="libcuda.so.1"), patch(
        "alchemy_stub.gpu_monitor.ctypes.CDLL", return_value=driver
    ):
        assert monitor._allocation_scope() == (set(), False)


def test_driver_ordinals_are_reindexed_even_for_nonzero_visible_identifier():
    import uuid
    identity = "GPU-00026566-97c5-d6d4-e283-cbcfa08bec7b"
    monitor = _monitor({"SLURM_JOB_ID": "200", "SLURM_JOB_GPUS": "3", "CUDA_VISIBLE_DEVICES": "3"})

    def set_count(pointer):
        pointer._obj.value = 1
        return 0

    def set_device(pointer, ordinal):
        assert ordinal == 0
        pointer._obj.value = 0
        return 0

    def set_uuid(pointer, device):
        pointer._obj.bytes[:] = uuid.UUID(identity.removeprefix("GPU-")).bytes
        return 0

    driver = SimpleNamespace(
        cuInit=MagicMock(return_value=0),
        cuDeviceGetCount=MagicMock(side_effect=set_count),
        cuDeviceGet=MagicMock(side_effect=set_device),
        cuDeviceGetUuid=MagicMock(side_effect=set_uuid),
    )
    with patch("alchemy_stub.gpu_monitor.ctypes.util.find_library", return_value="libcuda.so.1"), patch(
        "alchemy_stub.gpu_monitor.ctypes.CDLL", return_value=driver
    ):
        assert monitor._allocation_scope() == ({identity}, True)
        assert monitor._allocation_scope() == ({identity}, True)
        assert driver.cuDeviceGetCount.call_count == 1


def test_cuda_driver_resolution_uses_valid_real_ctypes_function_signatures():
    import ctypes
    import uuid
    identity = "GPU-00026566-97c5-d6d4-e283-cbcfa08bec7b"
    monitor = _monitor({"SLURM_JOB_ID": "200", "SLURM_JOB_GPUS": "5", "CUDA_VISIBLE_DEVICES": "0"})

    def set_count(pointer):
        pointer.contents.value = 1
        return 0

    def set_device(pointer, ordinal):
        pointer.contents.value = ordinal
        return 0

    def set_uuid(pointer, device):
        raw = ctypes.cast(pointer, ctypes.POINTER(ctypes.c_ubyte * 16))
        raw.contents[:] = uuid.UUID(identity.removeprefix("GPU-")).bytes
        return 0

    driver = SimpleNamespace(
        cuInit=ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_uint)(lambda flag: 0),
        cuDeviceGetCount=ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_int))(set_count),
        cuDeviceGet=ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.c_int)(set_device),
        cuDeviceGetUuid=ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_int)(set_uuid),
    )
    with patch("alchemy_stub.gpu_monitor.ctypes.util.find_library", return_value="libcuda.so.1"), patch(
        "alchemy_stub.gpu_monitor.ctypes.CDLL", return_value=driver
    ):
        assert monitor._allocation_scope() == ({identity}, True)


def test_cuda_driver_uuid_api_failure_is_unknown():
    monitor = _monitor({"SLURM_JOB_ID": "295565", "SLURM_JOB_GPUS": "5", "CUDA_VISIBLE_DEVICES": "0"})

    def set_count(pointer):
        pointer._obj.value = 1
        return 0

    def set_device(pointer, ordinal):
        pointer._obj.value = ordinal
        return 0

    driver = SimpleNamespace(
        cuInit=MagicMock(return_value=0),
        cuDeviceGetCount=MagicMock(side_effect=set_count),
        cuDeviceGet=MagicMock(side_effect=set_device),
        cuDeviceGetUuid=MagicMock(return_value=1),
    )
    with patch("alchemy_stub.gpu_monitor.ctypes.util.find_library", return_value="libcuda.so.1"), patch(
        "alchemy_stub.gpu_monitor.ctypes.CDLL", return_value=driver
    ):
        assert monitor._allocation_scope() == (set(), False)
