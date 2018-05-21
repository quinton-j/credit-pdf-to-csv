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
    fileToTransactions(inFile)
        .then(transactions => transactionsToCsvFile(transactions, outFile))
        .catch(error => console.error(`Failed converting ${inFile} to transactions:  ${error}`));
} else if (inDirectory) {
    Promise.all(fs.readdirSync(inDirectory).map(file => fileToTransactions(path.join(inDirectory, file))))
        .then(transactionNestedArray => [].concat.apply([], transactionNestedArray))
        .then(transactions => transactionsToCsvFile(transactions, outFile))
        .catch(error => console.error(`Failed converting ${inDirectory} to transactions:  ${error}`));
} else {
    console.info('in-file or in-directory must be specified');
}

function fileToTransactions(inFile) {
    return new Promise((resolve, reject) => {
        pdftUtil.pdfToText(inFile, { format: 'table' }, (error, data) => {
            try {
                if (error) {
                    reject(error);
                } else {
                    const { transactions, validationErrors } = parseTransactions(data);

                    if (validationErrors.length > 0) {
                        reject(validationErrors.join(os.EOL));
                    } else {
                        resolve(transactions);
                    }
                }
            } catch (error) {
                reject(error);
            }
        });
    }).then(categorizeTransactions)
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

function transactionsToCsvFile(transactions, outFile) {
    try {
        const csvString = json2csv(transactions, { fields: ['date', 'item', 'category', 'amount'] });
        fs.writeFileSync(outFile, csvString);
        console.info(`Successfully wrote output to ${outFile}`);
    } catch (error) {
        console.error('Failed to convert transactions to csv:', error);
    }
}

function categorizeTransactions(transactions) {
    for (let transaction of transactions) {
        transaction.category = getCategory(transaction);
    }
    return transactions;
}

function getCategory(transaction) {
    for (let forced of categories['forced']) {
        if (forced.item === transaction.item && forced.date === transaction.date) {
            return forced.category;
        }
    }

    for (let category in categories) {
        if (categories[category].find(term => transaction.item.includes(term))) {
            return category;
        }
    }

    return 'unclassified';
}

function parseTransactions(data) {
    if (/Scotia.*VISA.*[cC]ard/mg.test(data)) {
        return parseScotiabankTransactions(data);
    } else if (/CIBC.*Visa/mg.test(data)) {
        return parseCibcTransactions(data);
    } else {
        throw new Error('Unrecognized credit file');
    }
}

function parseScotiabankTransactions(data) {
    const yearMatches = /Statement date +(\w{3}) +\d{1,2}, +(\d{4})/mg.exec(data);
    const statementMonth = yearMatches[1];
    const statementYear = parseInt(yearMatches[2]);
    const transactions = [];
    const regex = /(\d{3}) +(\w{3} +\d{1,2}) +(?:\w{3} +\d{1,2} +)?(.+?)(?:AMT +(?:[\d,]+?\.\d{2}-?)? (?:[\w ]*?)?)? +([\d,]+?\.\d{2})(-?)(?:[^%])/g;
    let match;
    while (match = regex.exec(data)) {
        const date = new Date(`${statementYear}-${match[2].replace(' ', '-')}`);
        if (statementMonth === 'Jan' && date.getMonth() === 11) {
            date.setFullYear(statementYear - 1);
        }
        transactions.push({
            transactionId: parseInt(match[1]),
            amount: parseFloat(match[5] + match[4].replace(',', '')),
            item: match[3],
            date: `${date.getFullYear()}-${ensureTwoDigits(date.getMonth() + 1)}-${ensureTwoDigits(date.getDate())}`,
        });
    }

    const validationErrors = [];
    for (let i = 1; i < transactions.length; ++i) {
        if (transactions[i - 1].transactionId + 1 !== transactions[i].transactionId) {
            validationErrors.push(`Transactions ${i - 1} and ${i} are not contiguous`);
        }
    }

    const paymentMatches = /Payments\/credits[\s-$]+([\d,.]+)/mg.exec(data);
    const payments = parseFloat(paymentMatches[1].replace(',', ''));
    const purchasesMatches = /Purchases\/charges[\s\+$]+([\d,.]+)/mg.exec(data);
    const purchases = parseFloat(purchasesMatches[1].replace(',', ''));
    let checksum = purchases - payments;

    for (let transaction of transactions) {
        checksum -= transaction.amount;
    }

    if (Math.abs(checksum) > 0.01) {
        validationErrors.push(`Checksum failure:  ${checksum}`);
    }

    return { transactions, validationErrors };
}

function parseCibcTransactions(data) {
    const transactions = [];
    const validationErrors = [];

    console.info('This is a CIBC visa file');

    return { transactions, validationErrors };
}