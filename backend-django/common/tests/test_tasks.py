from common.tasks import ping


def test_ping_task_runs_eagerly_in_tests() -> None:
    assert ping.delay().get() == "pong"
