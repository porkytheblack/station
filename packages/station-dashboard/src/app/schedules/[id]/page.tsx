import { ScheduleEditor } from "./schedule-editor";

export default async function ScheduleEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ScheduleEditor id={id} />;
}
