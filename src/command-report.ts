/** Plain text only: the web renders cells as text, never Markdown or HTML. */
export interface CommandReport {
  title: string;
  columns: string[];
  rows: string[][];
  notes: string[];
}
export interface CommandReportAnswer { text: string; report: CommandReport }
