import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { getPatient } from "@/lib/patients";
import { displayName, requireUserId } from "@/lib/session";
import { saveNote } from "@/lib/tpuf";
import type { Note } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  if (config.readOnly) return NextResponse.json({ error: "Editing is turned off on this deployment." }, { status: 403 });
  const { patientId, note } = (await req.json()) as { patientId: string; note: Partial<Note> };
  if (!(await getPatient(patientId))) return NextResponse.json({ error: "Unknown patient." }, { status: 404 });
  const clean: Note = {
    id: note.id || `${patientId}-${randomUUID().slice(0, 8)}`,
    title: (note.title ?? "").trim().slice(0, 200) || "Untitled note",
    body: (note.body ?? "").slice(0, 20000),
    note_type: note.note_type || "Visit note",
    visit_date: note.visit_date || new Date().toISOString().slice(0, 10),
    // A new note is credited to whoever is signed in. An edit keeps the note's original author.
    author: note.id ? note.author || (await displayName()) : await displayName(),
  };
  try {
    const res = await saveNote(patientId, clean);
    return NextResponse.json({ note: clean, ...res });
  } catch (e) {
    return NextResponse.json({ error: `Save failed: ${(e as Error).message}` }, { status: 502 });
  }
}
