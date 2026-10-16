// Anonymous install telemetry for the public template.
//
// Replace INSTALL_COUNTER_URL with the /exec URL of your separate,
// standalone Apps Script counter deployment before publishing the template.
//
// This sends no spreadsheet ID, Google account information, receipt data,
// HSA balances, or medical information. It only POSTs once per copied script
// project and stores a local flag after a successful response.

const INSTALL_COUNTER_URL = 'PASTE_COUNTER_WEB_APP_EXEC_URL_HERE';
const INSTALL_REPORTED_PROPERTY = 'INSTALL_REPORTED';

function reportInstall_() {
  if (!INSTALL_COUNTER_URL ||
      INSTALL_COUNTER_URL === 'PASTE_COUNTER_WEB_APP_EXEC_URL_HERE') {
    return;
  }

  const props = PropertiesService.getScriptProperties();

  if (props.getProperty(INSTALL_REPORTED_PROPERTY) === 'true') {
    return;
  }

  const response = UrlFetchApp.fetch(INSTALL_COUNTER_URL, {
    method: 'post',
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status >= 200 && status < 300) {
    props.setProperty(INSTALL_REPORTED_PROPERTY, 'true');
    return;
  }

  throw new Error('Install counter returned HTTP ' + status + '.');
}
