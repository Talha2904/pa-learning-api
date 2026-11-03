import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { ExcelWorkbook } from '../../src/infrastructure/external-services/excel-workbook.js';

describe('ExcelWorkbook', () => {
  it('turns web links into clickable hyperlinks and leaves other text alone', async () => {
    const buffer = await new ExcelWorkbook().write([
      { name: 'Sheet', rows: [['Activity', 'Course Link'], ['AML update', 'https://www.icaew.com/learning/aml'], ['Ethics', null]], headerRow: 0 },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Sheet')!;
    expect(ws.getCell('B2').value).toEqual({ text: 'https://www.icaew.com/learning/aml', hyperlink: 'https://www.icaew.com/learning/aml' });
    expect(ws.getCell('A2').value).toBe('AML update');
    expect(ws.getCell('B3').value).toBe('');
  });

  it('reads a hyperlink cell back as its text (bulk upload of an exported file)', async () => {
    const xlsx = new ExcelWorkbook();
    const buffer = await xlsx.write([{ name: 'Items', rows: [['Title', 'Link'], ['AML update', 'https://example.com/course/1']] }]);
    const rows = await xlsx.readRows(new Uint8Array(buffer), 'items.xlsx');
    expect(rows[0]!.values).toMatchObject({ title: 'AML update', link: 'https://example.com/course/1' });
  });
});
