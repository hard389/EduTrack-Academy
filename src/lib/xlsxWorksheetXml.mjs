export function freezeWorksheetHeaderXml(xml) {
  const views = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>';
  if (/<sheetViews\b[^>]*>[\s\S]*?<\/sheetViews>/.test(xml)) {
    return xml.replace(/<sheetViews\b[^>]*>[\s\S]*?<\/sheetViews>/, views);
  }
  const dimension = xml.match(/<dimension\b[^>]*\/>/);
  if (dimension?.index !== undefined) {
    const insertAt = dimension.index + dimension[0].length;
    return `${xml.slice(0, insertAt)}${views}${xml.slice(insertAt)}`;
  }
  const format = xml.search(/<sheetFormatPr\b/);
  if (format >= 0) return `${xml.slice(0, format)}${views}${xml.slice(format)}`;
  const data = xml.search(/<sheetData\b/);
  if (data >= 0) return `${xml.slice(0, data)}${views}${xml.slice(data)}`;
  throw new Error('The generated Excel worksheet XML has an unsupported structure.');
}
