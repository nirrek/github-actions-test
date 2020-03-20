const fs = require('fs');
const { execSync } = require('child_process');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

// Populate process.env with environment variables found the .env file
// it it exists (we use a .env file in local development)
require('dotenv').config();

const SPREADSHEET_ID = '1vRgcJ17_FezC7tbm6qS2OIb6mZVETLYVagDstE3a-DM';
const SHEET_NAME = 'DraftImage';

// This describes the structure of the sheet. By having this lookup table
// it becomes clearer in our code what the intention of a given index or
// column character was. It also gives us a single place to check concordance
// with SHEET_NAME and make necessary adjustments.
const COLUMNS_BY_ID = {
  uuid: { index: 0, columnName: 'A', title: 'UUID' },
  originalUrl: { index: 1, columnName: 'B', title: 'Original URL' },
  comment: { index: 2, columnName: 'C', title: 'Comment' },
  document: { index: 3, columnName: 'D', title: 'Document' },
  figmaUrl: { index: 4, columnName: 'E', title: 'Figma URL' },
  designReview: { index: 5, columnName: 'F', title: 'Design Review' },
  newUrl: { index: 6, columnName: 'G', title: 'New URL to add to jsx-images.mathspace.co' },
  editorReview: { index: 7, columnName: 'H', title: 'Editor review' },
  addedToWorksheet: { index: 8, columnName: 'I', title: 'Added to Worksheet?' },
};

function columnIndexFor(columnId) {
  return COLUMNS_BY_ID[columnId].index;
}

function columnNameFor(columnId) {
  return COLUMNS_BY_ID[columnId].columnName;
}

// This performs very light validation on the remote spreadsheet.
// It ensures that we have the same number of heading columns, and
// that they are all entitled in the expected way. This is not fool-proof,
// but it will detect when people make egregious errors (such as moving
// a column, adding a column, changing the meaning of a column, etc)
async function validateSheetStructure(sheets) {
  const getResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    // Use a1 notation (https://developers.google.com/sheets/api/guides/concepts#a1_notation)
    // to select the first row of the sheet (the header row)
    range: `${SHEET_NAME}!1:1`,
  });

  const row = getResponse.data.values[0];

  const expectedNumCols = Object.keys(COLUMNS_BY_ID).length;
  if (row.length !== expectedNumCols) {
    throw new Error([
      `Someone has modified the spreadsheet structure in an invalid way.`,
      `There should be ${expectedNumCols} columns, instead there were ${row.length} columns.`
    ].join(' '));
  }

  Object.values(COLUMNS_BY_ID).forEach((column, i) => {
    const remoteValue = row[i];
    if (remoteValue !== column.title) {
      throw new Error([
      `Someone has modified the spreadsheet structure in an invalid way.`,
      `The ${i}th column should be called ${JSON.stringify(column.title)}, instead it's called: ${JSON.stringify(remoteValue)}`
    ].join(' '));
    }
  });
}

main().catch(error => {
  // TODO handle any errors that bubble up in a better way
  // eg. ping Slack
  console.error(error);
  process.exit(1);
});

async function main() {
  const {
    CURRENT_SHA,
    BEFORE_SHA,
    SHEETS_SERVICE_ACCOUNT_EMAIL,
    SHEETS_SERVICE_ACCOUNT_KEY,
  } = process.env;

  const changedFilePaths = execSync(
    `git diff ${BEFORE_SHA} ${CURRENT_SHA} --name-only`,
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);

  const jsxFilePaths = changedFilePaths.filter(filePath =>
    filePath.endsWith('.jsx'),
  );

  // If we haven't changed and .jsx files, no work to do. Exit early.
  if (jsxFilePaths.length === 0) return;

  const sheets = google.sheets({
    version: 'v4',
    auth: new google.auth.JWT({
      email: SHEETS_SERVICE_ACCOUNT_EMAIL,
      key: SHEETS_SERVICE_ACCOUNT_KEY,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    }),
  });

  // Before we begin, validate that the structure of the sheet it what we expect.
  // This is only a very weak form of validation, but gives us some protection.
  await validateSheetStructure(sheets);

  // A list of rows we may want to append (depends on what's already in the sheet)
  const maybeRowsToAppend = [];
  for (const filePath of jsxFilePaths) {
    const code = fs.readFileSync(filePath, 'utf8');

    const ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['jsx'],
    });

    traverse(ast, {
      JSXOpeningElement(path) {
        if (path.node.name.name === 'DraftImage') {
          const id = getAttributeValue('id', path);
          const url = getAttributeValue('url', path);
          const notesForImageCreator = getAttributeValue(
            'notesForImageCreator',
            path,
          );

          const row = createRow({
            uuid: id,
            originalUrl: url,
            comment: notesForImageCreator,
            document: documentName(filePath),
          });
          maybeRowsToAppend.push(row);
        }
      },
    });
  }

  const getResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_NAME, // Just find the main table in sheet using the heuristics
  });

  const idsList = getResponse.data.values
    .slice(1) // This removes the headings row at the 0th position
    .map(row => row[0]);
  const ids = new Set(idsList);

  // Only append rows for DraftImages whose ids are not already in the sheet.
  const rowsToAppend = maybeRowsToAppend.filter(
    row => !ids.has(row[columnIndexFor('uuid')]),
  );

  const appendResponse = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_NAME, // Just find the main table in Sheet1 using the heuristics
    valueInputOption: 'RAW', // Insert cell values as raw text
    resource: {
      values: rowsToAppend,
    },
  });

  // Figure out if there are UUIDs in the spreadsheet that do not
  // exist in any of our content. Log some warnings when this situation
  // is encountered.
  const idsFromWorksheets = new Set(
    maybeRowsToAppend.map(row => row[columnIndexFor('uuid')]),
  );
  const unactionedIdsFromSpreadsheet = getResponse.data.values
    .slice(1)
    .filter(row => row[columnIndexFor('addedToWorksheet')] !== 'TRUE')
    .map(row => row[0]);
  const missingIds = [];
  for (const id of unactionedIdsFromSpreadsheet) {
    if (!idsFromWorksheets.has(id)) missingIds.push(id);
  }

  if (missingIds.length > 0) {
    console.warn(
      '\n🚨 Warning: The following ids were in the spreadsheet, but not found in any documents: ',
    );
    console.warn('    ', missingIds, '\n');
  }

  // Success message
  console.log(
    `Appended ${rowsToAppend.length} rows to the <DraftImage> coordination spreadsheet`,
  );
}

// We do it like this to make it easier to adjust if the underlying
// column structure of the sheet has to change.
// TODO can we assert that this matches our COLUMNS_BY_ID def?
function createRow({
  uuid,
  originalUrl,
  comment,
  document,
  figmaUrl = '',
  designReview = 'No review',
  newUrl = '',
  editorReview = 'No review',
  addedToWorksheet = '',
}) {
  return [
    uuid,
    originalUrl,
    comment,
    document,
    figmaUrl,
    designReview,
    newUrl,
    editorReview,
    addedToWorksheet,
  ];
}

function documentName(filePath) {
  return filePath.split('/').slice(-1)[0];
}

// Precondition: attributeName is for a prop that has a string value.
function getAttributeValue(attributeName, path) {
  const attr = path.node.attributes.find(a => a.name.name === attributeName);
  if (!attr) return undefined;
  const { value } = attr;
  if (t.isStringLiteral(value)) return value.value;
  if (t.isJSXExpressionContainer(value)) return value.expression.value;
}
