export function dayTimeCron(days: number[], time: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (
    !match ||
    Number(match[1]) > 23 ||
    Number(match[2]) > 59 ||
    !days.length ||
    days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    throw new Error("Choose a day and a time from 00:00 to 23:59");
  return `${Number(match[2])} ${Number(match[1])} * * ${[...new Set(days)].sort().join(",")}`;
}
export function cronDayTime(cron: string) {
  const match = /^(\d+) (\d+) \* \* ([\d,*-]+)$/.exec(cron);
  if (!match) return undefined;
  const days: number[] = [];
  if (match[3] === "*") days.push(0, 1, 2, 3, 4, 5, 6);
  else
    for (const item of match[3].split(",")) {
      const [start, end = start] = item.split("-").map(Number);
      if (start < 0 || end > 6 || end < start) return undefined;
      for (let day = start; day <= end; day++) days.push(day);
    }
  return { days, time: `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}` };
}
