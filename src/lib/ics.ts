/**
 * Calendar files. A reminder that needs no server, no account and no
 * notification permission: the user's own calendar does the work.
 */

function stamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export type Reminder = { uid: string; at: number; title: string; description: string; url?: string };

export function calendarFile(reminders: Reminder[], createdAt: number): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Zodiac//Timebox//EN", "CALSCALE:GREGORIAN"];
  for (const r of reminders) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${r.uid}`,
      `DTSTAMP:${stamp(createdAt)}`,
      `DTSTART:${stamp(r.at)}`,
      `DTEND:${stamp(r.at + 900)}`,
      `SUMMARY:${escape(r.title)}`,
      `DESCRIPTION:${escape(r.description)}`,
      ...(r.url ? [`URL:${r.url}`] : []),
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escape(r.title)}`,
      "TRIGGER:PT0M",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function download(name: string, text: string, type = "text/calendar"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
