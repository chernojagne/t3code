import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState, type FormEvent } from "react";

import { useEnvironmentIdentities } from "../../state/environments";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useWorkstreamMutation } from "./useWorkstreamMutation";
import { useWorkstreamEditableEnvironmentIds, useWorkstreamEnvironmentIds } from "./workstreamData";
import {
  closeNewWorkstreamDialog,
  useWorkstreamDialogStore,
  type NewWorkstreamRequest,
} from "./workstreamDialogStore";
import { setSidebarViewPreference } from "./workstreamView";

function NewWorkstreamForm({ request }: { readonly request: NewWorkstreamRequest }) {
  const gt = useGT();
  const runMutation = useWorkstreamMutation();
  const identities = useEnvironmentIdentities();
  const editable = useWorkstreamEditableEnvironmentIds();
  const environmentIds = useWorkstreamEnvironmentIds().filter((id) => editable.has(id));
  const [name, setName] = useState("");
  const [pickedEnvironmentId, setPickedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [saving, setSaving] = useState(false);
  const environmentId = request.environmentId ?? pickedEnvironmentId ?? environmentIds[0] ?? null;
  const labelOf = (id: EnvironmentId) =>
    identities.find((identity) => identity.environmentId === id)?.label ?? id;
  const trimmed = name.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === "" || environmentId === null || saving) return;
    setSaving(true);
    const created = await runMutation(environmentId, { type: "workstream.create", name: trimmed });
    if (created?.workstreamId !== undefined && request.assignThreadId !== null) {
      await runMutation(environmentId, {
        type: "thread.assign",
        threadId: request.assignThreadId,
        workstreamId: created.workstreamId,
      });
    }
    setSaving(false);
    if (created === null) return;
    setSidebarViewPreference("workstreams");
    closeNewWorkstreamDialog();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="contents">
      <DialogHeader>
        <DialogTitle>
          <T>New workstream</T>
        </DialogTitle>
        <DialogDescription>
          {request.assignThreadId === null ? (
            <T>
              A workstream groups the threads working on one thing and gives them a shared memory.
            </T>
          ) : (
            <T>The thread moves into the new workstream.</T>
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-1.5">
          <Label htmlFor="new-workstream-name">
            <T>Name</T>
          </Label>
          <Input
            id="new-workstream-name"
            autoFocus
            value={name}
            placeholder={gt("Checkout redesign")}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {request.environmentId === null && environmentIds.length > 1 && environmentId !== null ? (
          <div className="space-y-1.5">
            <Label>
              <T>Environment</T>
            </Label>
            <Select
              value={environmentId}
              onValueChange={(next) => {
                if (next !== null) setPickedEnvironmentId(next);
              }}
            >
              <SelectTrigger aria-label={gt("Environment")}>
                <SelectValue>{labelOf(environmentId)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environmentIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {labelOf(id)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          <T>Cancel</T>
        </DialogClose>
        <Button
          type="submit"
          size="sm"
          disabled={trimmed === "" || environmentId === null || saving}
        >
          <T>Create workstream</T>
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The one "New workstream" dialog; the sidebar, a thread's menu and the palette all open it. */
export function NewWorkstreamDialog() {
  const request = useWorkstreamDialogStore((store) => store.newWorkstream);
  if (request === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeNewWorkstreamDialog();
      }}
    >
      <DialogPopup>
        <NewWorkstreamForm request={request} />
      </DialogPopup>
    </Dialog>
  );
}
