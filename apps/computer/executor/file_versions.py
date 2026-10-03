"""Public native recovery API; content remains in its origin workspace."""


class FileVersions:
    def __init__(self, workspace):
        self.workspace = workspace

    def capture(self, task_id, artifact_id, expected_version):
        return self.workspace.capture(artifact_id, expected_version, task_id)

    def trash(self, task_id, artifact_id, expected_version):
        return self.workspace.trash(artifact_id, expected_version, task_id)

    def restore(self, version_id, expected_current_version, task_id=None):
        return self.workspace.restore(version_id, expected_current_version, task_id)
