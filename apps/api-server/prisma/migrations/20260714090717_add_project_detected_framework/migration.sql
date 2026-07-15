-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "detectedDeploymentType" "DeploymentType" DEFAULT 'STATIC',
ADD COLUMN     "detectedFramework" "Framework" DEFAULT 'UNKNOWN';
