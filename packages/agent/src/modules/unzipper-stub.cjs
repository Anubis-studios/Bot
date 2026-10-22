// exceljs's streaming reader needs unzipper, whose dependencies ship no
// license text, so it is left out; `workbook.xlsx.readFile` reads the same files.
exports.Parse = () => {
  throw new Error(
    "The streaming reader is not included: use workbook.xlsx.readFile."
  );
};
