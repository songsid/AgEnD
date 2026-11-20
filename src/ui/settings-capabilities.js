// One visibility rule for the card, Settings search and Ctrl K. Unknown is hidden.
export const hostMonitoringVisible = schema => schema?.host_monitoring === true && schema?.host_monitoring_page === true;
