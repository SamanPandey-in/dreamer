import type { LucideIcon } from "lucide-react";

export function ComingSoonStub({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20 border border-dashed border-zinc-800 rounded-2xl">
      <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
        <Icon className="w-5 h-5 text-zinc-500" />
      </div>
      <h2 className="text-lg font-semibold text-zinc-200 mb-1">{title}</h2>
      <p className="text-sm text-zinc-500 max-w-sm">{description}</p>
    </div>
  );
}
