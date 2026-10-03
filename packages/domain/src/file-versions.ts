export interface FileVersionMetadata {
  id: string;
  executorId: string;
  artifactId: string;
  path: string;
  sha256: string;
  size: number;
  createdAt: number;
  taskId?: string | null;
  trashed: boolean;
  retentionDays: number;
}
export interface NativeArtifactMetadata {
  id: string;
  executorId: string;
  artifactId: string;
  path: string;
  version: string | null;
  sha256: string;
  size: number;
  mimeType: string;
  published: boolean;
  restoredAsCopy?: boolean;
  trashed?: boolean;
  generation?: number;
  versionId?: string;
}
export interface FileRecoverySnapshot {
  versions: FileVersionMetadata[];
  artifacts: NativeArtifactMetadata[];
  policy: {
    retentionDays: number;
    maxVersionBytes: number;
    scope: "controlled-tools";
    backupRequired: true;
  };
}
