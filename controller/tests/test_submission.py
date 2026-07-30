from alchemy_controller.daemon import ControllerDaemon, sanitize_job_name


def test_sanitize_job_name_is_safe_and_bounded():
    assert sanitize_job_name("JEMA D1 smoke / unsafe chars") == "jema-d1-smoke-unsafe-chars"
    assert len(sanitize_job_name("x" * 100)) == 64


def test_controller_script_uses_structured_submission_metadata():
    daemon = ControllerDaemon("https://example.invalid", "test-token")
    script = daemon._generate_sbatch_script({
        "partition": "gpu-small",
        "gres": "gpu:nvidia_a16:1",
        "qos": "normal",
        "job_name": "JEMA D1 smoke",
        "user": "tester",
    })
    assert "#SBATCH --job-name=jema-d1-smoke" in script
    assert "#SBATCH --partition=gpu-small" in script
    assert "#SBATCH --gres=gpu:nvidia_a16:1" in script
    assert "#SBATCH --qos=normal" in script
    assert "train_ct" not in script
