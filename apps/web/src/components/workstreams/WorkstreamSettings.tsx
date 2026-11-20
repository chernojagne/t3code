import { useAtomValue } from "@effect/atom-react";
import {
  WORKSTREAM_MEMORY_DEFAULT_GATE_THRESHOLD,
  WORKSTREAM_MEMORY_ENTRY_MAX_CHARS,
  WORKSTREAM_MEMORY_MAX_BUDGET_CHARS,
  WORKSTREAM_MEMORY_MIN_BUDGET_CHARS,
  type EnvironmentId,
  type Workstream,
  type WorkstreamId,
  type WorkstreamMemoryConfig,
  type WorkstreamMemoryEntry,
  type WorkstreamMemoryEntryKind,
} from "@t3tools/contracts";
import { pickModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { LockIcon, LockOpenIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import {
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentIdentities, useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { workstreamEnvironment } from "../../state/workstreams";
import { useTextGenerationTargets } from "../../textGenerators";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SecretInput } from "../settings/SecretInput";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useWorkstreamMutation } from "./useWorkstreamMutation";
import { useWorkstreamStates } from "./workstreamData";
import { parseGateThreshold, parseMemoryBudget } from "./workstreamSettings.logic";

const ENTRY_KINDS = ["decision", "convention", "fact", "open_item"] as const;

const ENTRY_KIND_LABELS: Record<WorkstreamMemoryEntryKind, string> = {
  decision: msg("Decision", { $context: "kind of workstream memory entry" }),
  convention: msg("Convention", { $context: "kind of workstream memory entry" }),
  fact: msg("Fact", { $context: "kind of workstream memory entry" }),
  open_item: msg("Open item", { $context: "kind of workstream memory entry" }),
};

function MemoryConfigSection({
  environmentId,
  config,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly config: WorkstreamMemoryConfig;
  readonly canEdit: boolean;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const runMutation = useWorkstreamMutation();
  const settings = useEnvironmentSettings(environmentId);
  const serverProviders = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const targets = useTextGenerationTargets({
    environmentId,
    settings,
    providers: serverProviders.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: null,
    selections: [config.mergeModelSelection, settings.textGenerationModelSelection],
  });
  const textGenerationSelection = resolveAppModelSelectionState(settings, targets.providers);
  const shownSelection = config.mergeModelSelection ?? textGenerationSelection;
  const hasProvider = targets.entries.some((entry) => entry.enabled && entry.isAvailable);
  const update = (
    patch: Omit<
      Extract<Parameters<typeof runMutation>[1], { type: "memory-config.update" }>,
      "type"
    >,
  ) => void runMutation(environmentId, { type: "memory-config.update", ...patch });

  return (
    <SettingsSection title={gt("Memory")} id="workstream-memory">
      <fieldset disabled={!canEdit} className="contents">
        <SettingsRow
          title={gt("Check each turn before remembering it")}
          description={gt(
            "A small OpenAI model judges whether a finished turn is worth remembering before it is merged.",
          )}
          control={
            <Switch
              checked={config.gateEnabled}
              disabled={!canEdit}
              aria-label={gt("Check each turn before remembering it")}
              onCheckedChange={(gateEnabled) => update({ gateEnabled })}
            />
          }
        >
          <p className="text-xs leading-normal text-muted-foreground">
            <T>
              When this is on and an OpenAI API key is set, a short digest of each finished turn in
              a workstream is sent to OpenAI's Decisions API, even for threads running on other
              providers. Without a key the check is skipped and every eligible turn goes to the
              merge model.
            </T>
          </p>
        </SettingsRow>
        <SettingsRow
          title={<label htmlFor="workstream-gate-threshold">{gt("Check threshold")}</label>}
          description={gt(
            "From 0 to 1, default {defaultValue}. A turn is remembered when the check scores it at or above this, so a lower value remembers more.",
            { defaultValue: String(WORKSTREAM_MEMORY_DEFAULT_GATE_THRESHOLD) },
          )}
          control={
            <DraftInput
              id="workstream-gate-threshold"
              size="sm"
              inputMode="decimal"
              className="w-full @min-[32rem]/settings-row:w-24"
              value={String(config.gateThreshold)}
              onCommit={(next) => {
                const gateThreshold = parseGateThreshold(next);
                if (gateThreshold !== null) update({ gateThreshold });
              }}
            />
          }
        />
        <SettingsRow
          title={<label htmlFor="workstream-gate-key">{gt("OpenAI API key")}</label>}
          description={
            config.gateKeyConfigured ? (
              <T>Configured. Stored on the server and never shown again.</T>
            ) : (
              <T>Not set. Stored on the server and never shown again.</T>
            )
          }
          control={
            <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-64">
              <SecretInput
                id="workstream-gate-key"
                size="sm"
                className="min-w-0 flex-1"
                configured={config.gateKeyConfigured}
                value=""
                onCommit={(next) => {
                  if (next.trim()) update({ gateApiKey: next.trim() });
                }}
              />
              {config.gateKeyConfigured ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost-destructive"
                  aria-label={gt("Remove the OpenAI API key")}
                  onClick={() => update({ gateApiKey: null })}
                >
                  <XIcon className="size-3.5" />
                </Button>
              ) : null}
            </div>
          }
        />
        <SettingsRow
          title={gt("Merge model")}
          description={gt(
            "The model that folds a remembered turn into the workstream's memory. Unless you pick one, the text generation model is used.",
          )}
          control={
            !hasProvider ? (
              <span className="text-sm text-muted-foreground">
                <T>No text generation providers available.</T>
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  environmentId={environmentId}
                  disabled={!canEdit}
                  activeInstanceId={shownSelection.instanceId}
                  model={shownSelection.model}
                  lockedProvider={null}
                  instanceEntries={targets.entries}
                  modelOptionsByInstance={getTextGenerationModelOptionsByInstance(
                    settings,
                    targets.providers,
                    shownSelection.instanceId,
                    shownSelection.model,
                  )}
                  isComposerOwned={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  {...(config.mergeModelSelection === null
                    ? { triggerLabel: gt("Use text generation model") }
                    : {})}
                  onOpenProviderSetup={(instanceId) => {
                    void navigate({
                      to: "/settings/providers",
                      search: { environmentId, instanceId },
                    });
                  }}
                  onInstanceModelChange={(instanceId, model) =>
                    update({
                      mergeModelSelection: pickModelSelection(
                        config.mergeModelSelection,
                        instanceId,
                        model,
                      ),
                    })
                  }
                />
                {config.mergeModelSelection === null ? null : (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => update({ mergeModelSelection: null })}
                  >
                    <T>Use text generation model</T>
                  </Button>
                )}
              </div>
            )
          }
        />
      </fieldset>
    </SettingsSection>
  );
}

function MemoryEntryRow({
  environmentId,
  entry,
  source,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: WorkstreamMemoryEntry;
  readonly source: string;
  readonly canEdit: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const mutateMemory = useAtomCommand(workstreamEnvironment.mutateMemory, {
    label: "update workstream memory",
  });
  const [draft, setDraft] = useState<{
    readonly text: string;
    readonly kind: WorkstreamMemoryEntryKind;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (input: Parameters<typeof mutateMemory>[0]["input"]) => {
    setBusy(true);
    const result = await mutateMemory({ environmentId, input });
    setBusy(false);
    return result._tag === "Success";
  };
  const saveDraft = async () => {
    if (draft === null || draft.text.trim() === "") return;
    const saved = await send({
      type: "entry.update",
      entryId: entry.id,
      kind: draft.kind,
      text: draft.text.trim(),
    });
    if (saved) setDraft(null);
  };

  return (
    <div
      data-testid="workstream-memory-entry"
      className="flex flex-col gap-2 border-t border-border/60 px-3 py-3 first:border-t-0 sm:px-4"
    >
      {draft === null ? (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge size="sm" variant="secondary">
                {m(ENTRY_KIND_LABELS[entry.kind])}
              </Badge>
              {entry.locked ? (
                <Badge size="sm" variant="outline">
                  <LockIcon aria-hidden />
                  <T context="memory entry that automatic updates cannot change">Locked</T>
                </Badge>
              ) : null}
              <span className="min-w-0 truncate text-xs text-muted-foreground">{source}</span>
            </div>
            <p dir="auto" className="text-sm whitespace-pre-wrap text-foreground">
              {entry.text}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={!canEdit || busy}
              aria-pressed={entry.locked}
              aria-label={entry.locked ? gt("Unlock entry") : gt("Lock entry")}
              onClick={() =>
                void send({ type: "entry.update", entryId: entry.id, locked: !entry.locked })
              }
            >
              {entry.locked ? <LockIcon aria-hidden /> : <LockOpenIcon aria-hidden />}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={!canEdit || busy}
              aria-label={gt("Edit entry")}
              onClick={() => setDraft({ text: entry.text, kind: entry.kind })}
            >
              <PencilIcon aria-hidden />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              disabled={!canEdit || busy}
              aria-label={gt("Delete entry")}
              onClick={() => void send({ type: "entry.delete", entryId: entry.id })}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </div>
        </div>
      ) : (
        <>
          <Textarea
            autoFocus
            aria-label={gt("Entry text")}
            maxLength={WORKSTREAM_MEMORY_ENTRY_MAX_CHARS}
            value={draft.text}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <EntryKindSelect value={draft.kind} onChange={(kind) => setDraft({ ...draft, kind })} />
            <Button size="xs" variant="outline" disabled={busy} onClick={() => setDraft(null)}>
              <T>Cancel</T>
            </Button>
            <Button
              size="xs"
              disabled={busy || draft.text.trim() === ""}
              onClick={() => void saveDraft()}
            >
              <T>Save</T>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function EntryKindSelect({
  value,
  onChange,
}: {
  readonly value: WorkstreamMemoryEntryKind;
  readonly onChange: (kind: WorkstreamMemoryEntryKind) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger aria-label={gt("Entry kind")} size="sm" className="w-36">
        <SelectValue>{m(ENTRY_KIND_LABELS[value])}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {ENTRY_KINDS.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {m(ENTRY_KIND_LABELS[kind])}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function AddEntryForm({
  environmentId,
  workstreamId,
}: {
  readonly environmentId: EnvironmentId;
  readonly workstreamId: WorkstreamId;
}) {
  const gt = useGT();
  const mutateMemory = useAtomCommand(workstreamEnvironment.mutateMemory, {
    label: "add workstream memory entry",
  });
  const [text, setText] = useState("");
  const [kind, setKind] = useState<WorkstreamMemoryEntryKind>("fact");
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (text.trim() === "") return;
    setBusy(true);
    const result = await mutateMemory({
      environmentId,
      input: { type: "entry.add", workstreamId, kind, text: text.trim(), locked },
    });
    setBusy(false);
    if (result._tag === "Success") setText("");
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border/60 px-3 py-3 sm:px-4">
      <Label htmlFor="workstream-memory-add">
        <T>Add entry</T>
      </Label>
      <Textarea
        id="workstream-memory-add"
        maxLength={WORKSTREAM_MEMORY_ENTRY_MAX_CHARS}
        placeholder={gt("Something every thread in this workstream should know")}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={locked} onCheckedChange={setLocked} />
          <T context="switch that protects a new memory entry from automatic updates">Locked</T>
        </label>
        <EntryKindSelect value={kind} onChange={setKind} />
        <Button size="xs" disabled={busy || text.trim() === ""} onClick={() => void add()}>
          <T>Add entry</T>
        </Button>
      </div>
    </div>
  );
}

function WorkstreamMemorySection({
  environmentId,
  workstream,
  canEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly workstream: Workstream;
  readonly canEdit: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const runMutation = useWorkstreamMutation();
  const mutateMemory = useAtomCommand(workstreamEnvironment.mutateMemory, {
    label: "clear workstream memory",
  });
  const memory = useEnvironmentQuery(
    workstreamEnvironment.memory({ environmentId, input: { workstreamId: workstream.id } }),
    m,
  );
  const threads = useThreadShells();
  const [instructions, setInstructions] = useState<string | null>(null);
  const entries = memory.data?.entries ?? [];
  const update = (
    patch: Omit<
      Extract<Parameters<typeof runMutation>[1], { type: "workstream.update" }>,
      "type" | "workstreamId"
    >,
  ) =>
    void runMutation(environmentId, {
      type: "workstream.update",
      workstreamId: workstream.id,
      ...patch,
    });
  const sourceOf = (entry: WorkstreamMemoryEntry) => {
    if (entry.sourceThreadId === null) return gt("You", { $context: "who wrote a memory entry" });
    const thread = threads.find(
      (candidate) =>
        candidate.environmentId === environmentId && candidate.id === entry.sourceThreadId,
    );
    return thread ? thread.title || gt("Untitled thread") : gt("A thread that is no longer listed");
  };
  const clearAll = async () => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await api.dialogs
      .confirm(
        [
          gt("Clear the memory of “{name}”?", { name: workstream.name }),
          gt("Every entry is deleted, locked ones included."),
        ].join("\n"),
        { variant: "destructive" },
      )
      .catch(() => false);
    if (!confirmed) return;
    await mutateMemory({
      environmentId,
      input: { type: "memory.clear", workstreamId: workstream.id },
    });
  };

  return (
    <>
      <fieldset disabled={!canEdit} className="contents">
        <SettingsRow
          title={gt("Shared memory")}
          description={gt(
            "Threads in this workstream are given its memory, and their finished turns can add to it.",
          )}
          control={
            <Switch
              checked={workstream.memory.enabled}
              disabled={!canEdit}
              aria-label={gt("Shared memory")}
              onCheckedChange={(memoryEnabled) => update({ memoryEnabled })}
            />
          }
        />
        <SettingsRow
          title={<label htmlFor="workstream-memory-instructions">{gt("What to remember")}</label>}
          description={gt(
            "In your own words, what is worth keeping for this workstream. Leave empty to use the built-in guidance.",
          )}
        >
          <Textarea
            id="workstream-memory-instructions"
            placeholder={gt("Decisions about the API shape, naming conventions, open questions…")}
            value={instructions ?? workstream.memory.instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onBlur={() => {
              if (instructions !== null && instructions !== workstream.memory.instructions) {
                update({ memoryInstructions: instructions });
              }
              setInstructions(null);
            }}
          />
        </SettingsRow>
        <SettingsRow
          title={<label htmlFor="workstream-memory-budget">{gt("Size budget")}</label>}
          description={gt(
            "In characters, from {minimum} to {maximum}. When the entries grow past it, the next update merges them down.",
            {
              minimum: String(WORKSTREAM_MEMORY_MIN_BUDGET_CHARS),
              maximum: String(WORKSTREAM_MEMORY_MAX_BUDGET_CHARS),
            },
          )}
          control={
            <DraftInput
              id="workstream-memory-budget"
              size="sm"
              inputMode="numeric"
              className="w-full @min-[32rem]/settings-row:w-24"
              value={String(workstream.memory.budgetChars)}
              onCommit={(next) => {
                const memoryBudgetChars = parseMemoryBudget(next);
                if (memoryBudgetChars !== null) update({ memoryBudgetChars });
              }}
            />
          }
        />
      </fieldset>
      <SettingsRow
        title={gt("Entries")}
        description={gt(
          "What this workstream remembers. Locked entries are never changed or removed by automatic updates.",
        )}
        control={
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!canEdit || entries.length === 0}
            onClick={() => void clearAll()}
          >
            <T>Clear all</T>
          </Button>
        }
      />
      {memory.data === null && memory.error !== null ? (
        <p className="px-3 py-3 text-sm text-destructive sm:px-4">{memory.error}</p>
      ) : memory.data === null ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4" role="status">
          <T>Loading memory…</T>
        </p>
      ) : entries.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          <T>Nothing remembered yet.</T>
        </p>
      ) : (
        entries.map((entry) => (
          <MemoryEntryRow
            key={entry.id}
            environmentId={environmentId}
            entry={entry}
            source={sourceOf(entry)}
            canEdit={canEdit}
          />
        ))
      )}
      {canEdit ? <AddEntryForm environmentId={environmentId} workstreamId={workstream.id} /> : null}
    </>
  );
}

/** Settings for workstream memory: the server-wide part, then one workstream's own memory. */
export function WorkstreamSettings(props: {
  readonly environmentId?: EnvironmentId;
  readonly workstream?: WorkstreamId;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const states = useWorkstreamStates();
  const identities = useEnvironmentIdentities();
  const selected =
    states.find((entry) => entry.environmentId === props.environmentId) ?? states[0] ?? null;
  const canEdit = useAtomValue(
    workstreamEnvironment.mutate.permissionAtom(selected?.environmentId ?? null),
  );
  const labelOf = (environmentId: EnvironmentId) =>
    identities.find((identity) => identity.environmentId === environmentId)?.label ?? environmentId;
  const select = (environmentId: EnvironmentId, workstream: WorkstreamId | null) =>
    void navigate({
      to: "/settings/workstreams",
      search: { environmentId, ...(workstream === null ? {} : { workstream }) },
      replace: true,
      resetScroll: false,
    });

  if (selected === null) {
    return (
      <SettingsPageContainer>
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          <T>Connect an environment that supports workstreams to change these settings.</T>
        </p>
      </SettingsPageContainer>
    );
  }
  const { environmentId, state } = selected;
  const workstreams = (state?.workstreams ?? []).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  const workstream =
    workstreams.find((candidate) => candidate.id === props.workstream) ?? workstreams[0] ?? null;

  return (
    <SettingsPageContainer>
      {states.length > 1 ? (
        <SettingsSection title={gt("Environment")} hideTitle>
          <SettingsRow
            title={gt("Environment")}
            description={gt("Workstreams and their memory belong to one environment.")}
            control={
              <Select
                value={environmentId}
                onValueChange={(next) => {
                  if (next !== null) select(next, null);
                }}
              >
                <SelectTrigger
                  aria-label={gt("Environment")}
                  size="sm"
                  className="w-full @min-[32rem]/settings-row:w-56"
                >
                  <SelectValue>{labelOf(environmentId)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {states.map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      {labelOf(entry.environmentId)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}
      {state === null ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4" role="status">
          {selected.failed ? <T>Could not load workstreams.</T> : <T>Loading workstreams…</T>}
        </p>
      ) : (
        <>
          <MemoryConfigSection
            key={environmentId}
            environmentId={environmentId}
            config={state.memoryConfig}
            canEdit={canEdit}
          />
          <SettingsSection title={gt("Workstream memory")} id="workstream-memory-entries">
            {workstream === null ? (
              <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
                <T>No workstreams yet. Create one from the sidebar's workstreams view.</T>
              </p>
            ) : (
              <>
                <SettingsRow
                  title={gt("Workstream")}
                  control={
                    <Select
                      value={workstream.id}
                      onValueChange={(next) => {
                        if (next !== null) select(environmentId, next);
                      }}
                    >
                      <SelectTrigger
                        aria-label={gt("Workstream")}
                        size="sm"
                        className="w-full @min-[32rem]/settings-row:w-56"
                      >
                        <SelectValue>{workstream.name}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {workstreams.map((candidate) => (
                          <SelectItem key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  }
                />
                <WorkstreamMemorySection
                  // Drafts belong to one workstream; switching must not carry them over.
                  key={`${environmentId}:${workstream.id}`}
                  environmentId={environmentId}
                  workstream={workstream}
                  canEdit={canEdit}
                />
              </>
            )}
          </SettingsSection>
        </>
      )}
    </SettingsPageContainer>
  );
}
