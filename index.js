const minimist = require('minimist');
const pdftUtil = require('pdf-to-text');
const fs = require('fs');
const json2csv = require('json2csv').parse;
const os = require('os');
const path = require('path');

const parsedArgs = minimist(process.argv);
const inFile = parsedArgs['in-file'];
const inDirectory = parsedArgs['in-directory'];
const outFile = parsedArgs['out-file'];
const categoryFile = parsedArgs['category-file'] || './category.json';

let categories = {};
if (fs.existsSync(categoryFile)) {
    categories = require(categoryFile);
}

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
                    const { records, validationErrors } = parseRecord(data);

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
    }).then(categorizeRecords)
        .catch(error => {
            throw new Error(`Error reading file ${inFile}:  ${error}`);
        });
}

function ensureTwoDigits(number) {
    const numberString = number.toString();
    return numberString.length < 2 ?
        '0' + numberString :
        numberString;
}

function recordsToCsvFile(records, outFile) {
    try {
        const csvString = json2csv(records, { fields: ['date', 'item', 'category', 'amount'] });
        fs.writeFileSync(outFile, csvString);
        console.info(`Successfully wrote output to ${outFile}`);
    } catch (error) {
        console.error('Failed to convert records to csv:', error);
    }
}

function categorizeRecords(records) {
    for (let record of records) {
        record.category = getCategory(record);
    }
    return records;
}

function getCategory(record) {
    for (let forced of categories['forced']) {
        if (forced.item === record.item && forced.date === record.date) {
            return forced.category;
        }
    }

    for (let category in categories) {
        if (categories[category].find(term => record.item.includes(term))) {
            return category;
        }
    }

    return 'unclassified';
}

function parseRecord(data) {
    if(/Scotia.*VISA.*[cC]ard/mg.test(data)) {
        return parseScotiabankRecord(data);
    } else {
        throw new Error('Unrecognized credit file');
    }
}

function parseScotiabankRecord(data) {
    const yearMatches = /Statement date +(\w{3}) +\d{1,2}, +(\d{4})/mg.exec(data);
    const statementMonth = yearMatches[1];
    const statementYear = parseInt(yearMatches[2]);
    const records = [];
    const regex = /(\d{3}) +(\w{3} +\d{1,2}) +(?:\w{3} +\d{1,2} +)?(.+?)(?:AMT +(?:[\d,]+?\.\d{2}-?)? (?:[\w ]*?)?)? +([\d,]+?\.\d{2})(-?)(?:[^%])/g;
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
            date: `${date.getFullYear()}-${ensureTwoDigits(date.getMonth() + 1)}-${ensureTwoDigits(date.getDate())}`,
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

    return { records, validationErrors };
}