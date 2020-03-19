const { execSync } = require('child_process');

const currentSha = process.env.current_sha;
const beforeSha = process.env.before_sha;

const changedFilePaths = execSync(
  `git diff ${beforeSha} ${currentSha} --name-only`,
  {
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter(Boolean);

const jsxFilePaths = changedFilePaths
  .filter(filePath => filePath.endsWith('.jsx'));

console.log('jsxFilePaths', jsxFilePaths);

// for (const filePath of jsxFilePaths) {
//   const jsx = fs.readFileSync(file, 'utf8');

//   // etc.
// }