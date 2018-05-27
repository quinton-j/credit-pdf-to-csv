const minimist = require('minimist');
const pdftUtil = require('pdf-to-text');
const fs = require('fs');
const json2csv = require('json2csv').parse;
const os = require('os');
const path = require('path');

const parsedArgs = minimist(process.argv, {
    alias: {
        o: 'out-file',
        f: 'in-file',
        d: 'in-directory'
    }
});
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
        function parseCallback(error, data) {
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
        }

        if (/\.ignore\./mg.test(inFile)) {
            resolve([]);
        } else if (/\.txt$/mg.test(inFile)) {
            fs.readFile(inFile, 'utf8', parseCallback);
        } else if (/\.pdf$/mg.test(inFile)) {
            pdftUtil.pdfToText(inFile, { format: 'table' }, parseCallback);
        } else {
            reject("unknown file type");
        }
    }).then(categorizeTransactions)
        .catch(error => {
            throw new Error(`Error reading file ${inFile}:  ${error}`);
        });
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
    } else if (/President's\sChoice\sFinancial.*Mastercard/mg.test(data)) {
        return parsePcTransactions(data);
    } else {
        throw new Error('Unrecognized credit file');
    }
}

function parseScotiabankTransactions(data) {
    const transactions = [];
    const validationErrors = [];

    const yearMatches = /Statement date +(\w{3}) +\d{1,2}, +(\d{4})/mg.exec(data);
    const statementMonth = yearMatches[1];
    const statementYear = parseInt(yearMatches[2]);

    const regex = /(\d{3}) +(\w{3} +\d{1,2}) +(?:\w{3} +\d{1,2} +)?(.+?)(?:AMT +(?:[\d,]+?\.\d{2}-?)? (?:[\w ]*?)?)? +([\d,]+?\.\d{2})(-?)(?:[^%])/g;
    let match;
    while (match = regex.exec(data)) {
        transactions.push({
            transactionId: parseInt(match[1]),
            amount: parseFloat(match[5] + match[4].replace(',', '')),
            item: match[3],
            date: getDateString(statementYear, statementMonth, match[2]),
        });
    }

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

function getDateString(statementYear, statementMonth, transactionDate) {
    const date = new Date(`${statementYear}-${transactionDate.replace(' ', '-')}`);
    if (statementMonth.startsWith('Jan') && date.getMonth() === 11) {
        date.setFullYear(statementYear - 1);
    }
    return `${date.getFullYear()}-${ensureTwoDigits(date.getMonth() + 1)}-${ensureTwoDigits(date.getDate())}`;
}

function ensureTwoDigits(number) {
    const numberString = number.toString();
    return numberString.length < 2 ? '0' + numberString : numberString;
}

function parseCibcTransactions(data) {
    const transactions = [];
    const validationErrors = [];

    const yearMatches = /Transactions from \w+ \d{1,2}(?:, \d{4})? +to +(\w+) +\d{1,2}, +(\d{4})/mg.exec(data);
    const statementMonth = yearMatches[1];
    const statementYear = parseInt(yearMatches[2]);

    const regex = /(\w+ \d{2}) +\w+ \d{2} +(.+?)(-?[\d,]+\.\d{2}[^%\*])/g;
    let match;
    while (match = regex.exec(data)) {
        const description = match[2].trim();
        if (!(/PAYMENT THANK YOU\/PAIEMENT +MERCI/.exec(description))) {
            transactions.push({
                amount: parseFloat(match[3].replace(',', '')),
                item: description,
                date: getDateString(statementYear, statementMonth, match[1]),
            });
        }
    }

    const totalMatches = /Total for +(?:\d{4} +){4}.+\$(\d*,?\d+\.\d{2})/mg.exec(data);
    let checksum = parseFloat(totalMatches[1].replace(',', ''));
    const interestMatches = /Total interest this period +\$(\d+\.\d{2})/mg.exec(data);
    if (interestMatches) {
        checksum += parseFloat(interestMatches[1].replace(',', ''));
    }

    for (let transaction of transactions) {
        checksum -= transaction.amount;
    }

    if (Math.abs(checksum) > 0.01) {
        validationErrors.push(`Checksum failure:  ${checksum}`);
    }

    return { transactions, validationErrors };
}

function parsePcTransactions(data) {
    const transactions = [];
    const validationErrors = [];

    const yearMatches = /statement date: +(\w{3})\.? \d{1,2}, +(\d{4})/mg.exec(data);
    const statementMonth = yearMatches[1];
    const statementYear = parseInt(yearMatches[2]);

    const regex = /(\d{2})\/(\d{2}) +\d{2}\/\d{2} +(.+?)(-?[\d,]+\.\d{2})/g;
    let match;
    while (match = regex.exec(data)) {
        const description = match[3].trim();
        if (!(/PAYMENT \/ PAIEMENT/.exec(description))) {
            //console.log(match[0]);
            transactions.push({
                amount: parseFloat(match[4].replace(',', '')),
                item: description,
                date: getDateString(statementYear, statementMonth, match[2] + '-' + match[1]),
            });
        }
    }

    const previousBalanceMatches = /Previous +Balance +\$(\d*,?\d+\.\d{2})/mg.exec(data);
    const previousBalance = parseFloat(previousBalanceMatches[1].replace(',', ''));

    let payments;
    const paymentsMatches = /total +paymentactivity +-?\$(\d*,?\d+\.\d{2})/mg.exec(data);
    if (paymentsMatches) {
        payments = parseFloat(paymentsMatches[1].replace(',', ''));
    } else {
        const paymentsMatches2 = /- payments [^ ]+ Thank you +\$(\d*,?\d+\.\d{2})/mg.exec(data);
        payments = parseFloat(paymentsMatches2[1].replace(',', ''));
    }

    const statementBalanceMatches = /Statement +Balance +\$(\d*,?\d+\.\d{2})/mg.exec(data);
    const statementBalance = parseFloat(statementBalanceMatches[1].replace(',', ''));

    let checksum = statementBalance + payments - previousBalance;

    for (let transaction of transactions) {
        checksum -= transaction.amount;
    }

    if (Math.abs(checksum) > 0.01) {
        validationErrors.push(`Checksum failure:  ${checksum}`);
    }

    return { transactions, validationErrors };
}
