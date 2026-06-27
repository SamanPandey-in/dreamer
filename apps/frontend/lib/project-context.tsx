"use client";

import { createContext, useContext } from "react";
import type { Project } from "./dashboard-types";

interface ProjectContextValue {
  project: Project;
  refreshProject: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({
  project,
  refreshProject,
  children,
}: ProjectContextValue & { children: React.ReactNode }) {
  return <ProjectContext.Provider value={{ project, refreshProject }}>{children}</ProjectContext.Provider>;
}

/**
 * Throws, rather than returning null, if called outside the provider — every
 * page under app/project/[projectId]/ is guaranteed to be inside it (the
 * layout never renders children until the project has loaded), so a null
 * return here would just push an "is it null?" check into six different
 * pages that can never actually observe a null in practice. A loud error in
 * dev is more useful than a silent one at runtime.
 */
export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProject() must be used within app/project/[projectId]/layout.tsx's <ProjectProvider>");
  }
  return ctx;
}
