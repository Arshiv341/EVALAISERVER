const { execSync } = require('child_process');

function checkPdftoppm() {
  try {
    execSync('pdftoppm -v', {
      stdio: 'ignore'
    });

    console.log('✅ pdftoppm detected');
    return true;

  } catch (error) {

    console.error('\n pdftoppm NOT installed\n');

    console.error(
      'OCR will fail because Poppler is missing.'
    );

    console.error('\nInstall instructions:\n');

    console.error('Ubuntu/Debian:');
    console.error('sudo apt install poppler-utils');

    console.error('\nRailway/Render Docker:');
    console.error('RUN apt-get update && apt-get install -y poppler-utils');

    console.error('\nWindows:');
    console.error('Use bundled poppler binaries');

    console.error('');

    return false;
  }
}

module.exports = {
  checkPdftoppm
};