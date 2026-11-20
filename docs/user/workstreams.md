# Workstreams

A workstream groups the threads working on one feature, bug, research effort or infrastructure
target. Threads keep their own project, so one workstream can span several projects. A thread is
in one workstream at most, and workstreams belong to the environment that holds their threads.

## The Workstreams sidebar

Switch the sidebar between threads and workstreams with the toggle in the sidebar footer, the
command palette, or the `sidebar.toggleWorkstreams` keybinding. The choice is saved on this device.

- Each workstream shows how long ago its most recently active thread was touched, and that
  thread's status.
- Sort workstreams by name, by staleness, or by hand. Drag to rearrange in manual order.
- Inside a workstream, pinned threads come first in the order you give them. The rest sort by
  most recent activity.
- Move a thread with its menu, by dragging it onto another workstream, or with **Move thread to
  workstream** in the command palette. Threads in no workstream are listed under **Unsorted**.
- Give a workstream a default project. New threads started from the workstream use that project
  and join the workstream.
- Threads an agent starts from a thread in a workstream join the same workstream.

Deleting a workstream keeps its threads, which become unsorted, and deletes its memory.

## Workstream memory

Every workstream keeps a shared memory: short entries for decisions, conventions, facts and open
items. After each finished turn, T3 Code checks whether the turn holds something worth keeping and
updates the entries. A new thread in the workstream is given the memory with its first message,
and later messages carry whatever other threads have added since. Memory outlives the threads that
wrote it, so a thread can be deleted without losing what it found.

Agents can also read the memory and save an entry themselves, so you can ask one to "remember
this for the workstream".

Manage memory in **Settings → Workstreams**:

- Turn memory on or off for a workstream, tell it what to remember, and set its size budget. When
  entries outgrow the budget, the next update merges them down.
- Edit, delete or add entries. A locked entry is never changed or removed by automatic updates.
- Moving a thread leaves what it already contributed in the old workstream. It receives the new
  workstream's memory on its next message.

### The memory gate

By default each eligible turn goes to the merge model, which uses your text generation model
unless you pick another. To avoid that call for turns with nothing worth keeping, add an OpenAI
API key under **Settings → Workstreams**. T3 Code then asks OpenAI's Decisions API first and only
merges turns that score at or above the threshold. A lower threshold remembers more.

With the gate on and a key stored, a short digest of each finished turn in a workstream is sent to
OpenAI, including turns from threads that run on other providers. Remove the key or turn the gate
off to stop that.
