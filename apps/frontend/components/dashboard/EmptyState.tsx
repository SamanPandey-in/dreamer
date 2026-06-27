import Link from "next/link";
import { Plus, Rocket } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function EmptyProjectsState() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-24 border border-dashed border-zinc-800 rounded-2xl">
      <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
        <Rocket className="w-5 h-5 text-zinc-500" />
      </div>
      <h2 className="text-lg font-semibold text-zinc-200 mb-1">Deploy your first project</h2>
      <p className="text-sm text-zinc-500 mb-6 max-w-sm">
        Import a Git repository and Dreamer will clone, build, and deploy it for you.
      </p>
      <Link href="/dashboard/new" className="contents">
        <Button variant="primary">
          <Plus className="w-4 h-4" />
          New Project
        </Button>
      </Link>
    </div>
  );
}
