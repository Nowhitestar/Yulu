# Yulu UI · Phase E — Knowledge Pages (Prompts + Glossary)

> Sub-spec of [`2026-05-26-yulu-frontend-design.md`](2026-05-26-yulu-frontend-design.md). Implements the two Knowledge pages described in §7.4 + §7.5 on top of the Phase B shell, the Phase A `prompts.*` and `glossary.*` routers, and the Phase C `<MasterDetail>` component.

## 1. Goal

Replace the Phase B placeholders for `/knowledge/prompts` and `/knowledge/glossary` with two fully interactive pages. After Phase E the user can browse / edit / create / delete prompts in a master-detail layout, and browse / edit / add / bulk-delete glossary terms in a table layout. Both pages auto-refresh from the `sidebar-counts` WS channel.

## 2. Non-goals

- Prompt reordering (Phase A doesn't implement a `reorder` procedure; spec §7.4 doesn't show reorder UI — defer)
- Glossary CSV import / export
- Prompt category color customization
- Per-prompt usage stats (which agent ran which prompt when)
- Drag-to-reorder
- Playwright E2E (Phase F sweep)
- Backend changes (Phase A's `prompts.*` and `glossary.*` cover every need)

## 3. Architecture

Two pages, two interaction patterns:

- **`/knowledge/prompts`** — master-detail (reuses Phase C's `<MasterDetail>`). Left: prompt list with category chip + autorun star. Right outlet: `<PromptReader>` form with explicit Save / Delete buttons (NOT inline-edit per the Settings pattern — prompts are multi-field forms where users want to draft a coherent change then commit). Nested routes for select (`:id`) and create (`new`).
- **`/knowledge/glossary`** — single-pane table via a new shared `<EditableTable>` component. Click-to-edit cells (text-only — all glossary fields are strings). Bulk select via checkbox column + bottom action bar. "+ Add term" button at top.

No backend changes. Phase A provides every procedure used.

## 4. URL Model

```
/knowledge/prompts                               list only (right outlet = "Select a prompt" empty state)
/knowledge/prompts/new                           list + empty reader in "create" mode
/knowledge/prompts/:id                           list + reader for existing prompt
/knowledge/glossary                              table (no nested routing)
```

The `:id` segment is the prompt's `id` field (e.g. `id-1`, `id-mxyz`).

## 5. New Components

Five additions in `web/src/components/`:

| Component | Responsibility |
|---|---|
| `<EditableTable>` | Generic column-config-driven table. Click-to-edit cells (text variant for v1). Optional checkbox column for bulk select. Sticky bottom action bar when `≥1` row selected. Reusable. |
| `<PromptReader>` | Form for editing/creating a prompt: name, slug, category dropdown, autorun toggle, content textarea (monospace, 15-line min, auto-grow). Per-field local dirty state. Save button enabled iff dirty (or create mode + valid). Delete button (existing prompts only) with confirmation. |
| `<CategoryChip>` | Tiny category badge for `summary` / `cleanup` / `voicemail`. ~12 lines. |
| `<PromptsIndex>` | Page-local index route content: `<EmptyState>` saying "Select a prompt to edit." Mirrors `voicemails.index.tsx` from C. |
| `useConfirm` (hook) | Tiny `window.confirm`-wrapping hook. `useConfirm()` returns `(message: string) => boolean`. Pure utility — lets us mock confirmation in tests. |

Glossary doesn't get its own component file — the page composes `<EditableTable>` directly.

The list row inside Prompts is rendered inline (~8 lines of JSX) — same pattern as Voicemails (C.10).

## 6. `<EditableTable>` Contract

```tsx
interface ColumnDef<Row> {
  key: keyof Row & string;
  label: string;
  editable?: boolean;            // false = read-only display
  width?: string;                // CSS column width
  format?: (v: Row[typeof key]) => React.ReactNode;   // optional value formatter (e.g. ISO date → "MM-DD HH:MM")
}

interface EditableTableProps<Row extends { id: string | number }> {
  columns: ColumnDef<Row>[];
  rows: Row[];
  onCellCommit: (rowId: Row["id"], key: string, value: string) => void;
  selectable?: boolean;                        // adds checkbox column
  onBulkDelete?: (rowIds: Row["id"][]) => void;
  emptyLabel?: string;
}
```

The component manages selection state internally (an internal `Set<rowId>`). The `onBulkDelete` callback is invoked with the selected ids after the user confirms.

For v1 only `text` cells are editable. Adding `select`, `toggle` etc. is a future-phase extension.

## 7. Data Flow

### 7.1 Prompts list

```ts
const { data } = trpc.prompts.list.useQuery({});
const [filter, setFilter] = useState<string[]>([]);
const visible = useMemo(
  () => filter.length === 0 ? (data ?? []) : (data ?? []).filter((p) => filter.includes(p.category)),
  [data, filter],
);
useWsChannel("sidebar-counts", () => qc.invalidateQueries({ queryKey: [["prompts", "list"]] }));
```

Filter chips (All / Summary / Cleanup / Voicemail) render inline in the list column (same pattern as voicemails C.13). "+ New prompt" button next to filters → `navigate("/knowledge/prompts/new")`.

### 7.2 Prompts reader (existing or create)

```ts
const { id = "" } = useParams();
const isCreate = id === "new";
const { data: prompt } = trpc.prompts.get.useQuery({ id }, { enabled: !isCreate });

const [draft, setDraft] = useState<{
  name?: string; slug?: string; category?: Category; content?: string; isAutoRun?: boolean;
}>({});
const isDirty = Object.keys(draft).length > 0;
const canSave = isCreate
  ? !!draft.name && !!draft.slug && !!draft.content && !!draft.category
  : isDirty;

const update = trpc.prompts.update.useMutation({ onSuccess: () => setDraft({}) });
const create = trpc.prompts.create.useMutation();
const del = trpc.prompts.delete.useMutation({ onSuccess: () => navigate("/knowledge/prompts") });

const onSave = async () => {
  if (isCreate) {
    const { id: newId } = await create.mutateAsync({ ...required fields from draft });
    navigate(`/knowledge/prompts/${newId}`);
  } else {
    await update.mutateAsync({ id, ...draft });
  }
};

const confirm = useConfirm();
const onDelete = async () => {
  if (!confirm(`Delete prompt "${prompt?.name}"?`)) return;
  await del.mutateAsync({ id });
};
```

Server SIGHUPs `com.yulu.agentqueue` automatically on every prompt mutation (Phase A wired this in `routers/prompts.ts`). No client-side restart banner needed.

### 7.3 Glossary

```ts
const { data } = trpc.glossary.list.useQuery();
const update = trpc.glossary.update.useMutation();
const add = trpc.glossary.add.useMutation();
const del = trpc.glossary.delete.useMutation();
useWsChannel("sidebar-counts", () => qc.invalidateQueries({ queryKey: [["glossary","list"]] }));

const COLUMNS: ColumnDef<VocabRow>[] = [
  { key: "term", label: "Term", editable: true, width: "200px" },
  { key: "pinyin", label: "Pinyin", editable: true, width: "120px" },
  { key: "notes", label: "Notes", editable: true },
  { key: "updated_at", label: "Last edited", editable: false, width: "140px", format: (v) => formatDate(v as string) },
];

<EditableTable
  columns={COLUMNS}
  rows={data ?? []}
  onCellCommit={(id, key, value) => update.mutateAsync({ id: Number(id), [key]: value })}
  selectable
  onBulkDelete={async (ids) => {
    for (const id of ids) await del.mutateAsync({ id: Number(id) });
  }}
  emptyLabel="No terms yet. Click + Add term to create one."
/>
```

"+ Add term" button above the table fires `add.mutateAsync({ term: "" })`. After success, optimistically focus the new row's term cell (via `data-testid="cell-{newId}-term"` and an effect).

Server SIGHUPs `com.yulu.sttdaemon` automatically on every glossary mutation. No client-side banner.

## 8. URL & navigation specifics

- `/knowledge/prompts/new` is a sibling of `/knowledge/prompts/:id`. We declare it BEFORE `:id` in the route table so the literal `"new"` matches first.
- Index route: when URL is `/knowledge/prompts` exactly, the outlet renders `<PromptsIndex>` (empty state).
- `navigate("/knowledge/prompts")` after delete clears the `:id` segment — outlet falls back to index.

## 9. Loading + empty states

| State | Behavior |
|---|---|
| Prompts list pending | MasterDetail's `listPending` flag → 8 skeleton rows |
| Prompts list empty (no prompts at all) | List column renders `<EmptyState label="No prompts yet. Click + New prompt to add one." />` |
| Prompts reader, `:id` not found | `<EmptyState label="Prompt not found." />` |
| Glossary list pending | Table body renders 5 skeleton rows (inline in `<EditableTable>`) |
| Glossary list empty | Table body renders `emptyLabel` text in a single centered row |

## 10. Test Strategy

Per-component tests:
- `EditableTable.test.tsx`: column render, cell click → edit input, blur commits, checkbox select → bulk action bar, bulk delete with confirm
- `PromptReader.test.tsx`: shows current prompt fields, dirty tracking, Save fires update mutation, Delete fires confirm + delete + navigate, create mode (no `:id`) hides Delete + Save fires create
- `useConfirm.test.ts`: returns truthy when `window.confirm` returns true, falsy otherwise

Per-page integration tests:
- `knowledge.prompts.test.tsx`: list renders, click row → reader, click "+ New prompt" → create mode
- `knowledge.glossary.test.tsx`: table renders rows, click cell → edit → blur commits, "+ Add term" fires add, select rows + Delete fires bulk delete

## 11. Acceptance Criteria

Phase E ships when:

1. **Prompts list** renders all rows with name + `<CategoryChip>` + `★` for autorun prompts. WS event → list refreshes.
2. **Prompt reader** (existing): editing fields enables Save; Save persists to DB + clears dirty; Delete (with confirm) removes + navigates back.
3. **New prompt** (`/knowledge/prompts/new`): empty form, Delete hidden, Save enabled when all required fields present; Save creates + navigates to `/knowledge/prompts/:newId`.
4. **Prompts filters** (All/Summary/Cleanup/Voicemail) filter the list client-side.
5. **Glossary table** renders all rows with term/pinyin/notes/updated_at columns. WS event → list refreshes.
6. **Glossary cell edit**: click cell → text input appears; blur or Enter commits via `glossary.update`. Other cells in the same row are NOT affected.
7. **Glossary add term**: click "+ Add term" → `glossary.add({term:""})`; new row appears at the top with the term cell focused for editing.
8. **Glossary bulk delete**: checking ≥1 row reveals the bottom action bar with the count + Delete button. Clicking Delete confirms then loops `glossary.delete` per id.
9. **All previous tests pass + new tests pass + `npm run typecheck` clean.** Real-machine smoke (dev + prod modes + browser navigation through both pages) shows no console errors.

## 12. File Structure

```
yulu/scripts/yulu_ui/web/
├── src/
│   ├── hooks/
│   │   └── useConfirm.ts                       NEW
│   ├── components/
│   │   ├── EditableTable.{tsx,css}             NEW
│   │   ├── PromptReader.{tsx,css}              NEW
│   │   └── CategoryChip.{tsx,css}              NEW
│   └── routes/knowledge/
│       ├── prompts.tsx                          MOD — list + nested route shell
│       ├── prompts.$id.tsx                      NEW — reader (handles both existing :id and "new")
│       ├── prompts.index.tsx                    NEW — empty state for the "no selection" case
│       └── glossary.tsx                         MOD — full table page
└── tests/web/
    ├── useConfirm.test.ts                       NEW
    ├── EditableTable.test.tsx                   NEW
    ├── PromptReader.test.tsx                    NEW
    ├── CategoryChip.test.tsx                    NEW
    ├── knowledge.prompts.test.tsx               NEW
    └── knowledge.glossary.test.tsx              NEW
```

`App.tsx` gets one structural change: the existing `/knowledge/prompts` and `/knowledge/glossary` route entries become richer (prompts gains nested children: `{index: true, Component: PromptsIndex}` + `{path: ":id", Component: PromptReader}`). Order matters: declare `:id` route — React Router will match `new` as `:id="new"`, and the reader code checks `isCreate = id === "new"` to switch modes. Alternatively, declare a literal `new` route first then `:id` — equally valid. We use the `isCreate` switch inside one component to avoid duplicate route entries.

## 13. What's deferred to later phases

| Phase | Scope |
|---|---|
| F | Health pages (Daemons grid + Logs tail via `useWsChannel('logs')`); Playwright E2E sweep after all real pages exist |
| G | setup.sh integration, yulu doctor entry, release packaging |

Future polish (out of scope for E):
- Prompt reordering (drag, sort_order updates)
- Glossary CSV import / export
- Per-prompt run history / usage stats
- Multi-field column editors (select / toggle in cells)
