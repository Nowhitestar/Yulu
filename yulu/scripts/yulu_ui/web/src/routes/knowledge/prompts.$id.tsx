// web/src/routes/knowledge/prompts.$id.tsx
import { useParams, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import {
  PromptReader,
  type PromptData,
  type CreateInput,
  type UpdateInput,
} from "../../components/PromptReader.js";
import { EmptyState } from "../../components/EmptyState.js";

export const handle = { breadcrumb: "Knowledge / Prompts", filters: null };

export function PromptReaderRoute() {
  const { id = "" } = useParams();
  const isCreate = id === "new";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isPending } = trpc.prompts.get.useQuery(
    { id },
    { enabled: !isCreate },
  );

  const updateMut = trpc.prompts.update.useMutation();
  const createMut = trpc.prompts.create.useMutation();
  const deleteMut = trpc.prompts.delete.useMutation();

  if (!isCreate && isPending) return <EmptyState label="Loading…" />;
  if (!isCreate && !data) return <EmptyState label={`Prompt "${id}" not found.`} />;

  const prompt = isCreate ? null : (data as PromptData);

  const onSave = async (input: UpdateInput | CreateInput) => {
    if (isCreate) {
      const created = await createMut.mutateAsync(input as CreateInput);
      await qc.invalidateQueries({ queryKey: [["prompts", "list"]] });
      navigate(`/knowledge/prompts/${created.id}`);
    } else {
      await updateMut.mutateAsync({ id, ...(input as UpdateInput) });
      await qc.invalidateQueries({ queryKey: [["prompts", "list"]] });
      await qc.invalidateQueries({ queryKey: [["prompts", "get", { id }]] });
    }
  };

  const onDelete = async () => {
    await deleteMut.mutateAsync({ id });
    await qc.invalidateQueries({ queryKey: [["prompts", "list"]] });
    navigate("/knowledge/prompts");
  };

  return <PromptReader prompt={prompt} onSave={onSave} onDelete={onDelete} />;
}
