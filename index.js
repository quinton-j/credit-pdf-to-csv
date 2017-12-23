const minimist = require('minimist');
const pdftUtil = require('pdf-to-text');
const fs = require('fs');
const json2csv = require('json2csv');
const os = require('os');
const path = require('path');

const parsedArgs = minimist(process.argv);
const inFile = parsedArgs['in-file'];
const inDirectory = parsedArgs['in-directory'];
const outFile = parsedArgs['out-file'];

if (!outFile) {
    console.error('Output file must be specified');
} else if (inFile) {
    fileToRecords(inFile)
        .then(records => recordsToCsvFile(records, outFile))
        .catch(error => console.error(`Failed converting ${inFile} to records:  ${error}`));
} else if (inDirectory) {
    Promise.all(fs.readdirSync(inDirectory).map(file => fileToRecords(path.join(inDirectory, file))))
        .then(recordNestedArray => [].concat.apply([], recordNestedArray))
        .then(records => recordsToCsvFile(records, outFile))
        .catch(error => console.error(`Failed converting ${inDirectory} to records:  ${error}`));
} else {
    console.info('in-file or in-directory must be specified');
}

function fileToRecords(inFile) {
    return new Promise((resolve, reject) => {
        pdftUtil.pdfToText(inFile, { format: 'table' }, (error, data) => {
            try {
                if (error) {
                    reject(error);
                } else {
                    const yearMatches = /Statement date +(\w{3}) +\d{1,2}, +(\d{4})/mg.exec(data);
                    const statementMonth = yearMatches[1];
                    const statementYear = parseInt(yearMatches[2]);
                    const records = [];
                    const regex = /(\d{3}) +(\w{3} +\d{1,2}) +(?:\w{3} +\d{1,2} +)?(.+?)(?:AMT +(?:[\d,]+?\.\d{2}-?)? (?:[\w ]*?)?)? +([\d,]+?\.\d{2})(-?)/g;
                    let match;
                    while (match = regex.exec(data)) {
                        const date = new Date(`${statementYear}-${match[2].replace(' ', '-')}`);
                        if (statementMonth === 'Jan' && date.getMonth() === 11) {
                            date.setFullYear(statementYear - 1);
                        }
                        records.push({
                            recordId: parseInt(match[1]),
                            amount: parseFloat(match[5] + match[4].replace(',', '')),
                            item: match[3],
                            date: `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`,
                        });
                    }

                    const validationErrors = [];
                    for (let i = 1; i < records.length; ++i) {
                        if (records[i - 1].recordId + 1 !== records[i].recordId) {
                            validationErrors.push(`Records ${i - 1} and ${i} are not contiguous`);
                        }
                    }

                    const paymentMatches = /Payments\/credits[\s-$]+([\d,.]+)/mg.exec(data);
                    const payments = parseFloat(paymentMatches[1].replace(',', ''));
                    const purchasesMatches = /Purchases\/charges[\s\+$]+([\d,.]+)/mg.exec(data);
                    const purchases = parseFloat(purchasesMatches[1].replace(',', ''));
                    let checksum = purchases - payments;

                    for (let record of records) {
                        checksum -= record.amount;
                    }

                    if (Math.abs(checksum) > 0.01) {
                        validationErrors.push(`Checksum failure:  ${checksum}`);
                    }

                    if (validationErrors.length > 0) {
                        reject(validationErrors.join(os.EOL));
                    } else {
                        resolve(records);
                    }

                }
            } catch (error) {
                reject(error);
            }
        });
    }).catch(error => {
        throw new Error(`Error reading file ${inFile}:  ${error}`);
    });
}

function recordsToCsvFile(records, outFile) {
    json2csv({
        data: records,
        fields: ['date', 'item', 'amount']
    }, (error, csvString) => {
        if (error) {
            console.error('Failed to convert records to csv:', error);
        } else {
            fs.writeFileSync(outFile, csvString);
            console.info(`Successfully wrote output to ${outFile}`);
        }
    });
}