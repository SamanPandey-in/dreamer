"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { detectBuildConfig, listFrameworkPresets, describeApiError } from "@/lib/dashboard-api";
import type { DetectedBuildConfig, FrameworkPresetId, PublicFrameworkPreset } from "@/lib/dashboard-types";
import { Button } from "@/components/ui/Button";

export interface BuildConfigValues {
  projectName: string;
  frameworkPresetId: FrameworkPresetId;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
}

/** Turns "my-cool-app" into a reasonable starting project name — repo names are already close to valid project slugs, so this mostly just exists to seed the field with something better than empty. project.service.ts's own slug generation handles uniqueness/sanitization server-side; this is purely a friendly starting point, not validation. */
function suggestedProjectName(repoName: string): string {
  return repoName;
}

/**
 * A single labeled field with a toggle to override the detected default —
 * matches screenshot 3's pattern exactly: the field is disabled and shows
 * the detected value as placeholder text until the toggle is flipped, at
 * which point it becomes a real editable input. This is also what keeps
 * "detected vs. user-set" an honest distinction in the submitted payload —
 * see the wizard's handleSubmit, which only sends a field's value at all
 * when its toggle is on.
 */
function OverridableField({
  label,
  placeholder,
  value,
  overridden,
  onToggle,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  overridden: boolean;
  onToggle: (next: boolean) => void;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-sm text-zinc-300">{label}</label>
        <button
          type="button"
          role="switch"
          aria-checked={overridden}
          onClick={() => onToggle(!overridden)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            overridden ? "bg-blue-500" : "bg-zinc-700"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              overridden ? "translate-x-5" : "translate-x-1"
            }`}
          />
        </button>
      </div>
      <input
        value={overridden ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={!overridden}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      />
    </div>
  );
}

export function BuildConfigForm({
  repoFullName,
  repoName,
  branch,
  rootDirectory,
  onContinue,
  onBack,
}: {
  repoFullName: string;
  repoName: string;
  branch: string;
  rootDirectory: string;
  onContinue: (values: BuildConfigValues) => void;
  onBack: () => void;
}) {
  const [projectName, setProjectName] = useState(() => suggestedProjectName(repoName));
  const [presets, setPresets] = useState<PublicFrameworkPreset[] | null>(null);
  const [detected, setDetected] = useState<DetectedBuildConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [selectedPresetId, setSelectedPresetId] = useState<FrameworkPresetId>("static");
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  // Per-field override state — see OverridableField's docstring. All three
  // start false: the form shows detected/preset defaults as placeholders
  // until the user explicitly opts into editing one.
  const [installOverride, setInstallOverride] = useState(false);
  const [buildOverride, setBuildOverride] = useState(false);
  const [outputOverride, setOutputOverride] = useState(false);
  const [installValue, setInstallValue] = useState("");
  const [buildValue, setBuildValue] = useState("");
  const [outputValue, setOutputValue] = useState("");

  const hasLoaded = useRef(false);

  useEffect(() => {
    if (hasLoaded.current) return;
    hasLoaded.current = true;

    Promise.all([listFrameworkPresets(), detectBuildConfig(repoFullName, branch, rootDirectory)])
      .then(([fetchedPresets, detectedConfig]) => {
        setPresets(fetchedPresets);
        setDetected(detectedConfig);
        setSelectedPresetId(detectedConfig.framework.id);
      })
      .catch((err) => setError(describeApiError(err, "Failed to detect project configuration")))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The currently-active defaults to show as placeholders — `detected`'s
   * own values while the dropdown still matches what was auto-detected
   * (so matchedOn-derived nuances like Next.js's static-export distinction
   * are preserved), or the plain preset table's defaults the moment the
   * user manually picks something else.
   */
  function activeDefaults() {
    if (detected && selectedPresetId === detected.framework.id) {
      return {
        installCommand: detected.installCommand,
        buildCommand: detected.buildCommand,
        outputDirectory: detected.outputDirectory,
      };
    }
    const preset = presets?.find((p) => p.id === selectedPresetId);
    return {
      installCommand: preset?.installCommand ?? "",
      buildCommand: preset?.buildCommand ?? "",
      outputDirectory: preset?.outputDirectory ?? "",
    };
  }

  const defaults = activeDefaults();
  const selectedPreset = presets?.find((p) => p.id === selectedPresetId);
  const showUnsupportedWarning =
    detected && selectedPresetId === detected.framework.id && detected.framework.requiresUnsupportedRuntime;

  function handleContinue() {
    onContinue({
      projectName: projectName.trim(),
      frameworkPresetId: selectedPresetId,
      installCommand: installOverride ? installValue : defaults.installCommand,
      buildCommand: buildOverride ? buildValue : defaults.buildCommand,
      outputDirectory: outputOverride ? outputValue : defaults.outputDirectory,
    });
  }

  if (loading) {
    return (
      <div className="max-w-2xl flex items-center gap-2 text-sm text-zinc-500 py-12">
        <Loader2 className="w-4 h-4 animate-spin" />
        Detecting project configuration…
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-2xl">
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 mb-4">
          {error}
        </p>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-1">New Project</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Importing from GitHub
        <br />
        <span className="text-zinc-400">
          {repoFullName} · {branch}
          {rootDirectory ? ` · ${rootDirectory}` : ""}
        </span>
      </p>

      <div className="mb-5">
        <label className="block text-sm text-zinc-300 mb-1.5">Project Name</label>
        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder={repoName}
          className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm font-mono placeholder:text-zinc-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
        />
      </div>

      <div className="mb-5">
        <label className="block text-sm text-zinc-300 mb-1.5">Application Preset</label>
        <select
          value={selectedPresetId}
          onChange={(e) => {
            const next = e.target.value as FrameworkPresetId;
            setSelectedPresetId(next);
            // Switching presets resets any per-field override — the
            // detected/preset defaults for the NEW preset are what should
            // show, not stale text typed for the old one.
            setInstallOverride(false);
            setBuildOverride(false);
            setOutputOverride(false);
          }}
          className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-white text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-colors"
        >
          {presets?.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
        {detected?.matchedOn && selectedPresetId === detected.framework.id && (
          <p className="text-xs text-zinc-500 mt-1.5">Detected via {detected.matchedOn}</p>
        )}
      </div>

      {showUnsupportedWarning && (
        <div className="flex gap-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3.5 py-3 mb-5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-200/90">
            {selectedPreset?.label} typically needs a long-running server, which this platform doesn&apos;t
            run yet — only static builds deploy correctly today. If your project supports a static
            export mode, enable it before deploying; otherwise this deployment may not work as expected.
          </p>
        </div>
      )}

      <div className="border border-zinc-800 rounded-xl mb-6">
        <button
          type="button"
          onClick={() => setSettingsExpanded((v) => !v)}
          className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-zinc-200"
        >
          {settingsExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          Build and Output Settings
        </button>

        {settingsExpanded && (
          <div className="px-4 pb-4 flex flex-col gap-4 border-t border-zinc-800 pt-4">
            <OverridableField
              label="Build Command"
              placeholder={defaults.buildCommand || "Not required"}
              value={buildValue}
              overridden={buildOverride}
              onToggle={(next) => {
                setBuildOverride(next);
                if (next && !buildValue) setBuildValue(defaults.buildCommand);
              }}
              onChange={setBuildValue}
            />
            <OverridableField
              label="Output Directory"
              placeholder={defaults.outputDirectory || "."}
              value={outputValue}
              overridden={outputOverride}
              onToggle={(next) => {
                setOutputOverride(next);
                if (next && !outputValue) setOutputValue(defaults.outputDirectory);
              }}
              onChange={setOutputValue}
            />
            <OverridableField
              label="Install Command"
              placeholder={defaults.installCommand || "Not required"}
              value={installValue}
              overridden={installOverride}
              onToggle={(next) => {
                setInstallOverride(next);
                if (next && !installValue) setInstallValue(defaults.installCommand);
              }}
              onChange={setInstallValue}
            />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={handleContinue} disabled={!projectName.trim()}>
          Continue
        </Button>
      </div>
    </div>
  );
}
