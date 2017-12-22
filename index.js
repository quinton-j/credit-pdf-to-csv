const minimist = require('minimist');
const pdftUtil = require('pdf-to-text');
const fs = require('fs');
const json2csv = require('json2csv');

const parsedArgs = minimist(process.argv);
const inFile = parsedArgs['file'];
const outFile = parsedArgs['out-file'];

if (!outFile) {
    console.error('Output file must be specified');
} else if (inFile) {
    pdftUtil.pdfToText(inFile, { format: 'table' }, function (error, data) {
        if (error) {
            console.error(`Error reading file ${inFile}:`, error);
        } else {
            const yearMatches = /Statement Period\s+\w{3}\s+\d{1,2},\s+(\d{4})/mg.exec(data);
            const year = yearMatches[1];
            const records = [];
            const regex = /(\d{3})\s+(\w{3}\s+\d{1,2})\s+\w{3}\s+\d{1,2}\s+(.+?)\s+([\d,]+?\.\d{2})(-?)/mg;
            let match;
            while (match = regex.exec(data)) {
                const date = new Date(`${year}-${match[2].replace(' ', '-')}`);
                records.push({
                    recordId: parseInt(match[1]),
                    date: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
                    item: match[3],
                    amount: parseFloat(match[5] + match[4]),
                });
            }

            for (let i = 1; i < records.length; ++i) {
                if (records[i - 1].recordId + 1 !== records[i].recordId) {
                    console.error(`Records ${i - 1} and ${i} are not contiguous`);
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

            if (!checksum) {
                console.error(`Checksum failure:`, checksum);
            }

            json2csv({
                data: records,
                fields: ['date', 'item', 'amount']
            }, function (error, csvString) {
                if (error) {
                    console.error('Failed to convert records to csv:', error);
                } else {
                    fs.writeFileSync(outFile, csvString);
                }
            });
        }
    });
} else {
    console.info('File must be specified');
}

