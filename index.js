import { existsSync } from 'fs';
import { readdir, readFile, writeFile } from 'fs/promises';
import { promisify } from 'util';
import { EOL } from 'os';
import { join } from 'path';

import minimist from 'minimist';
import pdftUtil from 'pdf-to-text';
import { Parser } from '@json2csv/plainjs';

(async function main() {
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
    if (existsSync(categoryFile)) {
        categories = JSON.parse(await readFile(categoryFile));
    }

    let files = [];

    if (!outFile) {
        throw new Error('Output file must be specified');
    } else if (inFile) {
        files.push(inFile);
    } else if (inDirectory) {
        files = files.concat((await readdir(inDirectory)).map(file => join(inDirectory, file)));
    } else {
        throw new Error('in-file or in-directory must be specified');
    }

    try {
        await writeTransactionsToCsvFile(
            (await Promise.all(files.map(file => fileToTransactions(categories, file))))
                .flat(),
            outFile);
        console.info(`Successfully wrote output to ${outFile}`);
    } catch (error) {
        throw new Error(`Failed converting ${inFile} to transactions:  ${error}`);
    }
})();

async function fileToTransactions(categories, inFile) {
    try {
        if (/\.ignore\./mg.test(inFile)) {
            return [];
        } else {

            let data;
            if (/\.txt$/mg.test(inFile)) {
                data = await readFile(inFile);
            } else if (/\.pdf$/mg.test(inFile)) {
                data = await (promisify(pdftUtil.pdfToText))(inFile, { format: 'table' });
            } else {
                throw new Error(`unknown file type`);
            }

            const { transactions, validationErrors } = parseTransactions(data);

            if (validationErrors.length > 0) {
                throw new Error(validationErrors.join(EOL));
            } else {
                transactions.sort((a, b) => a.date.localeCompare(b.date));
                return categorizeTransactions(categories, transactions);
            }
        }
    } catch (error) {
        throw new Error(`Error transactionifying file ${inFile}:  ${error}`);
    }
}

async function writeTransactionsToCsvFile(transactions, outFile) {
    try {
        const csvString = new Parser({
            fields: ['date', 'item', 'category', 'amount']
        }).parse(transactions);

        return writeFile(outFile, csvString);
    } catch (error) {
        throw new Error('Failed to convert transactions to csv:', error);
    }
}

function categorizeTransactions(categories, transactions) {
    for (let transaction of transactions) {
        transaction.category = getCategory(categories, transaction);
    }
    return transactions;
}

function getCategory(categories, transaction) {
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
    const yearMatches = /Statement date +(\w{3}) +\d{1,2}, +(\d{4})/mg.exec(data);
    const statementMonth = yearMatches[1];
    const statementYear = parseInt(yearMatches[2]);

    const regex = /\s+(\d{3}) {2}[\s\w\\]*?(\w{3} +\d{1,2}) +(?:\w{3} +\d{1,2} +)?(.+?)(?:AMT +(?:[\d,]+?\.\d{2}-?)? (?:[\w ]*?)?)? +([\d,]+?\.\d{2})(-?)(?:[^%])/g;
    let match;

    const transactions = [];
    while (match = regex.exec(data)) {
        transactions.push({
            transactionId: parseInt(match[1]),
            amount: parseFloat(match[5] + match[4].replace(',', '')),
            item: match[3],
            date: getDateString(statementYear, statementMonth, match[2]),
        });
    }

    const validationErrors = [];
    for (let i = 1; i < transactions.length; ++i) {
        const previousId = transactions[i - 1].transactionId;
        const currentId = transactions[i].transactionId;

        if (previousId + 1 !== currentId) {
            validationErrors.push(`Transactions ${previousId} and ${currentId} are not contiguous`);
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

    const yearMatches = /Transactions from \w+ +\d{1,2}(?:, +\d{4})? +to +(\w+) +\d{1,2}, +(\d{4})/mg.exec(data);

    if (!yearMatches) {
        console.warn('No transactions found.');
    } else {
        const statementMonth = yearMatches[1];
        const statementYear = parseInt(yearMatches[2]);

        const regex = /(\w+ \d{2}) +\w+ {1,3}\d{2}[ Ý]+(.+?)(-?[\d,]+\.\d{2}[^%\*])/g;
        let match;
        while (match = regex.exec(data)) {
            const description = match[2].trim();
            const isPayment =
                /PAYMENT THANK YOU\/PAIEMENT +MERCI/.exec(description) ||
                /SCOTIABANK PAYMENT/.exec(description);
            transactions.push({
                amount: parseFloat(match[3].replace(',', '')) * (isPayment ? -1 : 1),
                item: description,
                date: getDateString(statementYear, statementMonth, match[1]),
            });
        }

        const totalCredits = /Total credits\s+-\s+\$(\d*,?\d+\.\d{2})/mg;
        let checksum = 0;
        while (match = totalCredits.exec(data)) {
            checksum -= parseFloat(match[1].replace(',', ''));
        }
        const totalCharges = /Total charges\s+\+\s+\$(\d*,?\d+\.\d{2})/mg;
        while (match = totalCharges.exec(data)) {
            checksum += parseFloat(match[1].replace(',', ''));
        }

        for (let transaction of transactions) {
            checksum -= transaction.amount;
        }

        if (Math.abs(checksum) > 0.01) {
            validationErrors.push(`Checksum failure:  ${checksum}`);
        }
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