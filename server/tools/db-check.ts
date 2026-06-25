import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function analyze() {
  const csvPath = 'g:/Solar/tools/data/simulation.csv';
  console.log("Reading CSV...");
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw.trim().split('\n');
  const headers = lines[0].split(',');
  const irrIdx = headers.indexOf('irr');
  const labelIdx = headers.indexOf('f_nv');
  const origIdx = headers.indexOf('original_index');
  const vdc1Idx = headers.indexOf('vdc1');

  console.log(`Headers: ${headers.join(', ')}`);
  console.log(`Total rows: ${lines.length - 1}`);

  let dayStart = -1;
  let dayEnd = -1;
  let dayCount = 0;
  let nightCount = 0;

  let dayInfo: any[] = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(Number);
    const irr = vals[irrIdx];
    const vdc1 = vals[vdc1Idx];
    const isDay = irr > 10 || vdc1 > 10;

    if (isDay) {
      dayCount++;
      if (dayStart === -1) {
        dayStart = i - 1; // 0-indexed row
      }
      dayEnd = i - 1;
    } else {
      nightCount++;
      if (dayStart !== -1) {
        dayInfo.push({ start: dayStart, end: dayEnd, length: dayEnd - dayStart + 1 });
        dayStart = -1;
        dayEnd = -1;
      }
    }
  }
  if (dayStart !== -1) {
    dayInfo.push({ start: dayStart, end: dayEnd, length: dayEnd - dayStart + 1 });
  }

  console.log("Day periods found in simulation.csv:", dayInfo);
  console.log(`Total day rows: ${dayCount}, Total night rows: ${nightCount}`);
  
  // Find Day 16 boundary index
  const boundaryIndex = lines.slice(1).findIndex(line => {
    const vals = line.split(',').map(Number);
    return vals[origIdx] >= 1288619;
  });
  console.log("Boundary index (Day 16 start):", boundaryIndex);
}

analyze();
