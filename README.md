# credit-pdf-to-csv

## Description

Parses, categorizes, and converts to transactions from a VISA pdf to a CSV file.  User must create a `category.json` file in the running directory to categorize the transactions.

## Categories

`category.json` file must be of the form

```json
{
    "forced": [
        {
            "date": "2014-12-11",
            "item": "specific description text",
            "category": "car"
        }
    ],
    "grocery": [
        "GROCERY",
        "Store 1 description",
        "Store 2 description"
    ]
}
```

The forced section is expected and can be used to target an exact record to a new category.  All other sections are processed for an includes match until one is found.  If no matches are found, the record is marked as "unclassified".

## Usage

The script can run against an individual file:

`node index.js --in-file myVisaFile.pdf --out-file myVisaRecords.csv`

Or against a directory:

``node index.js --in-directory ./myVisaFiles/ --out-file myVisaRecords.csv``
