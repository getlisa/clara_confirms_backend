# Zentrades API doc for Confirms only

## 1. API for fetching jobs and visits

- POST [https://services.zentrades.pro/api/ticket/search/filtered?page=1&size=100&sortBy[]=%7B%22scheduledStartTime%22:%22DESC%22%7D](https://services.zentrades.pro/api/ticket/search/filtered?page=1&size=10&sortBy[]=%7B%22scheduledStartTime%22:%22DESC%22%7D)
- Payload:

```
    {
        "gteDate": [
            {
                "scheduledEndTime": "2026-09-07T18:30:00.000Z"
            }
        ],
        "ltDate": [
            {
                "scheduledStartTime": "2026-09-14T18:30:00.000Z"
            }
        ],
        "businessUnitIds": [],
        "terms": [
            {
                "jobStatusId": [
                    "1"
                ]
            }
        ]
    }
```

- ("1" for open job status), size in query parameter can be increased upto 500
- Sample response format:

```
requestId: null
count: 23
hits:
{
  "id": 1924543,
  "ticketNumber": "009670",
  "scheduledStartTime": "2026-09-14T13:15:00.000Z",
  "scheduledEndTime": "2026-09-14T15:15:00.000Z",
  "jobTypeId": 4205,
  "workCodeId": 2113,
  "jobStatusId": 1,
  "jobDescription": "Test",
  "potentialRevenue": 0,
  "campaignId": 1,
  "options": {
    "callback": false,
    "jobPriority": 0,
    "notifyForPO": false
  },
  "serviceAddressId": 418,
  "customerId": 368,
  "companyId": 3,
  "isActive": true,
  "isDeleted": false,
  "createdUserId": 3,
  "updatedUserId": 3,
  "createdBy": {
    "id": 3,
    "firstName": "Business",
    "lastName": "Admin",
    "username": "engineering+prod@smartserv.io",
    "email": "engineering+prod@smartserv.io",
    "isAdmin": true,
    "roleId": 7,
    "companyId": 3,
    "timeZoneId": 1,
    "isActive": true,
    "isDeleted": false,
    "updatedBy": "app_rw@10.0.2.150",
    "updatedAt": "2026-04-29T12:13:02.000Z",
    "createdAt": "2020-10-27T13:52:06.000Z",
    "profilePhoto": "tWshQBZEVa",
    "landline": "(435) 353-4211",
    "cellphone": "(123) 456-7890",
    "ext": "123",
    "costRate": 0,
    "billableRate": 0,
    "rateCriterion": "COST",
    "rateBasis": "HOURLY",
    "firstname": "Business",
    "lastname": "Admin"
  },
  "updatedBy": "app_rw@10.0.2.181",
  "createdAt": "2026-09-07T13:08:50.000Z",
  "updatedAt": "2026-09-07T13:08:50.000Z",
  "readyForSync": true,
  "combinedFeatureFlag": "RECURRING_VISIT",
  "jobStatus": "Open",
  "jobType": "AC Repair",
  "workType": "destined to fail",
  "workCode": "destined to fail",
  "campaign": {
    "id": 1,
    "name": "Facebook",
    "cost": 100,
    "image": "NVxSehymj4",
    "companyId": 3,
    "isActive": true,
    "isDeleted": false,
    "createdUserId": 3,
    "updatedUserId": 3,
    "createdBy": "api_rw@10.0.4.197",
    "updatedBy": "api_rw@10.0.3.174",
    "createdAt": "2020-10-29T08:18:49.000Z",
    "updatedAt": "2022-04-22T08:47:00.000Z",
    "campaignName": "Facebook"
  },
  "assignments": [
    {
      "id": 2790843,
      "endTime": "2026-09-14T15:15:00.000Z",
      "startTime": "2026-09-14T13:15:00.000Z",
      "assignmentStatusId": 1,
      "technicianId": 4705,
      "description": "",
      "ticketId": 1924543,
      "travelTime": 0,
      "deviceId": 1,
      "recurringAssignmentId": 1788786528,
      "companyId": 3,
      "isActive": true,
      "isDeleted": false,
      "updatedUserId": 3,
      "createdUserId": 3,
      "createdBy": "app_rw@10.0.2.181",
      "updatedBy": "app_rw@10.0.2.181",
      "createdAt": "2026-09-07T13:08:50.000Z",
      "updatedAt": "2026-09-07T13:08:50.000Z",
      "technician": {
        "id": 4705,
        "firstName": "1Ank",
        "lastName": "ww",
        "username": "maitri.maniya@smartserv.io",
        "email": "maitri.maniya@smartserv.io",
        "isAdmin": false,
        "roleId": 1380,
        "companyId": 3,
        "timeZoneId": 1,
        "isActive": true,
        "isDeleted": false,
        "updatedBy": "app_rw@10.0.2.181",
        "updatedAt": "2026-08-03T20:10:32.000Z",
        "createdAt": "2022-08-16T11:04:44.000Z",
        "profilePhoto": "0",
        "costRate": 0,
        "billableRate": 0,
        "rateCriterion": "COST",
        "rateBasis": "HOURLY",
        "firstname": "1Ank",
        "lastname": "ww"
      },
      "status": "Open",
      "assignmentStatusCFId": 2,
      "statusCF": "Open: return trip needed"
    },
    {
      "id": 2790844,
      "endTime": "2026-09-14T15:15:00.000Z",
      "startTime": "2026-09-14T13:15:00.000Z",
      "assignmentStatusId": 1,
      "technicianId": 10697,
      "description": "",
      "ticketId": 1924543,
      "travelTime": 0,
      "deviceId": 1,
      "recurringAssignmentId": 1788786529,
      "companyId": 3,
      "isActive": true,
      "isDeleted": false,
      "updatedUserId": 3,
      "createdUserId": 3,
      "createdBy": "app_rw@10.0.2.181",
      "updatedBy": "app_rw@10.0.2.181",
      "createdAt": "2026-09-07T13:08:50.000Z",
      "updatedAt": "2026-09-07T13:08:50.000Z",
      "technician": {
        "id": 10697,
        "firstName": "20",
        "lastName": "go 1",
        "username": "20go@zt.pro",
        "email": "20go@zt.pro",
        "isAdmin": false,
        "roleId": 17,
        "companyId": 3,
        "timeZoneId": 1,
        "isActive": true,
        "isDeleted": false,
        "updatedBy": "app_rw@10.0.3.159",
        "updatedAt": "2025-11-20T13:59:39.000Z",
        "createdAt": "2025-11-20T13:59:38.000Z",
        "profilePhoto": 10697,
        "landline": "3029 8490",
        "cellphone": "3498 3294",
        "ext": "",
        "costRate": 0,
        "billableRate": 0,
        "rateCriterion": "COST",
        "rateBasis": "HOURLY",
        "referenceId": "",
        "firstname": "20",
        "lastname": "go 1"
      },
      "status": "Open",
      "assignmentStatusCFId": 2,
      "statusCF": "Open: return trip needed"
    }
  ],
  "serviceAddress": {
    "id": 418,
    "addressLine1": "2074 Steeles Avenue East1",
    "addressLine2": "line-21",
    "city": "Brampton1",
    "state": "AK",
    "zipcode": "12345",
    "country": "US",
    "geoLocation": {
      "lat": 43.7104832,
      "lng": -79.6860795
    },
    "companyId": 3,
    "isTaxable": true,
    "customerId": 368,
    "addressTypeId": 2,
    "isActive": true,
    "isDeleted": false,
    "doNotServe": false,
    "createdBy": "api_rw@10.0.3.174",
    "updatedBy": "api_rw@10.0.2.181",
    "updatedAt": "2022-05-10T11:32:07.000Z",
    "createdAt": "2020-11-28T00:51:52.000Z",
    "createdUserId": 3,
    "updatedUserId": 3,
    "isTCEFireApplicable": false,
    "serviceAddressSync": [],
    "firstname": "28thh",
    "lastname": "November ",
    "name": "Nov Com12",
    "additionalName": "november",
    "landline": "(123) 456-7890",
    "ext": "32822",
    "cellphone": "(348) 324-8122",
    "email": "sandeep@smartserv.iooo",
    "displayName": "Nov Com12",
    "customerIdentifier": "Nov Com (8361869)",
    "customerUniqueId": "Nov Com (8361869)",
    "rootParentId": "",
    "parentId": "",
    "isProspect": false,
    "addressType": "serviceAddress",
    "additionalContacts": [
      {
        "id": 28,
        "name": "abc",
        "email": "abc@s.iooo",
        "landline": "(000) 000-0000",
        "ext": "22222",
        "cellphone": "(666) 666-6666",
        "addressId": 418,
        "companyId": 3,
        "createdBy": "api_rw@10.0.3.174",
        "updatedBy": "api_rw@10.0.3.174",
        "updatedAt": "2020-11-28T01:15:44.000Z",
        "createdAt": "2020-11-28T00:51:52.000Z",
        "createdUserId": 3,
        "updatedUserId": 3,
        "isActive": true,
        "isDeleted": false
      }
    ],
    "notes": {
      "id": 97,
      "text": "November notes 1",
      "isActive": true,
      "isDeleted": false,
      "isPrivate": false,
      "createdUser": 3,
      "updatedUser": 3,
      "createdBy": "api_rw@10.0.3.174",
      "updatedBy": "api_rw@10.0.3.174",
      "createdAt": "2020-11-28T00:51:52.000Z",
      "updatedAt": "2020-11-28T00:51:52.000Z"
    }
  },
  "customer": {
    "id": 368,
    "companyId": 3,
    "displayName": "Nov Com12",
    "firstname": "28thh",
    "lastname": "November ",
    "name": "Nov Com12",
    "additionalName": "november",
    "landline": "(123) 456-7890",
    "ext": "32822",
    "cellphone": "(348) 324-8122",
    "email": "sandeep@smartserv.iooo",
    "customerIdentifier": "Nov Com (8361869)",
    "customerUniqueId": "Nov Com (8361869)",
    "skipLevel": false,
    "isActive": true,
    "isDeleted": false,
    "createdBy": "api_rw@10.0.3.174",
    "updatedBy": "smarsterv_admin@10.0.3.174",
    "updatedAt": "2024-03-01T12:01:05.000Z",
    "createdAt": "2020-11-28T00:51:52.000Z",
    "createdUserId": 3,
    "updatedUserId": 3,
    "quickbookData": [
      {
        "id": 4841,
        "customerId": 368,
        "companyId": 3,
        "qbListId": "",
        "qbEditSequence": "",
        "lastSyncedAt": "2021-02-05T15:29:33.000Z",
        "isSynced": false,
        "isDeleted": false,
        "createdBy": "api_rw@10.0.3.37",
        "updatedBy": "smarsterv_admin@10.0.3.174",
        "createdAt": "2021-02-05T15:29:32.000Z",
        "updatedAt": "2024-05-29T09:48:45.000Z",
        "flowInvoiceInParent": false
      }
    ],
    "readyForSync": true,
    "isProspect": false,
    "billingAddress": {
      "id": 417,
      "addressLine1": "2074 Steeles Avenue East2",
      "addressLine2": "line-22",
      "city": "Brampton2",
      "state": "YT",
      "zipcode": "L6T 4Z2",
      "country": "Canada",
      "companyId": 3,
      "isTaxable": true,
      "customerId": 368,
      "propertyTypeId": 1,
      "addressTypeId": 1,
      "paymentTermId": "dUkidQiwnN",
      "isActive": true,
      "isDeleted": false,
      "doNotServe": false,
      "createdBy": "api_rw@10.0.3.174",
      "updatedBy": "api_rw@10.0.3.174",
      "updatedAt": "2020-11-28T01:12:53.000Z",
      "createdAt": "2020-11-28T00:51:52.000Z",
      "createdUserId": 3,
      "updatedUserId": 3,
      "isTCEFireApplicable": false,
      "firstname": "28thh",
      "lastname": "November ",
      "name": "Nov Com12",
      "additionalName": "november",
      "landline": "(123) 456-7890",
      "ext": "32822",
      "cellphone": "(348) 324-8122",
      "email": "sandeep@smartserv.iooo",
      "displayName": "Nov Com12",
      "customerIdentifier": "Nov Com (8361869)",
      "customerUniqueId": "Nov Com (8361869)",
      "rootParentId": "",
      "parentId": "",
      "isProspect": false,
      "additionalContacts": [
        {
          "id": 27,
          "name": "abc",
          "email": "abc@s.io",
          "landline": "(000) 000-0000",
          "ext": "22222",
          "cellphone": "(888) 888-8888",
          "addressId": 417,
          "companyId": 3,
          "createdBy": "api_rw@10.0.3.174",
          "updatedBy": "api_rw@10.0.3.174",
          "updatedAt": "2020-11-28T01:12:52.000Z",
          "createdAt": "2020-11-28T00:51:52.000Z",
          "createdUserId": 3,
          "updatedUserId": 3,
          "isActive": true,
          "isDeleted": false
        }
      ],
      "notes": {
        "id": 96,
        "text": "November notes 2",
        "isActive": true,
        "isDeleted": false,
        "isPrivate": false,
        "createdUser": 3,
        "updatedUser": 3,
        "createdBy": "api_rw@10.0.3.174",
        "updatedBy": "api_rw@10.0.3.174",
        "createdAt": "2020-11-28T00:51:52.000Z",
        "updatedAt": "2020-11-28T00:51:52.000Z"
      }
    }
  },
  "openDeficiencyCount": 0
}
```



## 2. API for fetching recurring information

- GET [https://services.zentrades.pro/api/ticket?id=1924543](https://services.zentrades.pro/api/ticket?id=1924543)
- Sample response:

```
{
    "status": "success",
    "requestId": null,
    "result": {
        "id": 1924543,
        "ticketNumber": "009670",
        "scheduledStartTime": "2026-09-14T13:15:00.000Z",
        "scheduledEndTime": "2026-09-14T15:15:00.000Z",
        "jobTypeId": 4205,
        "workCodeId": 2113,
        "jobStatusId": 1,
        "jobDescription": "Test",
        "potentialRevenue": 0,
        "campaignId": 1,
        "options": {
            "callback": false,
            "jobPriority": 0,
            "notifyForPO": false
        },
        "serviceAddressId": 418,
        "customerId": 368,
        "companyId": 3,
        "isActive": true,
        "isDeleted": false,
        "createdUserId": 3,
        "updatedUserId": 3,
        "createdBy": {
            "id": 3,
            "firstName": "Business",
            "lastName": "Admin",
            "username": "engineering+prod@smartserv.io",
            "email": "engineering+prod@smartserv.io",
            "isAdmin": true,
            "roleId": 7,
            "companyId": 3,
            "timeZoneId": 1,
            "isActive": true,
            "isDeleted": false,
            "updatedBy": "app_rw@10.0.2.150",
            "updatedAt": "2026-04-29T12:13:02.000Z",
            "createdAt": "2020-10-27T13:52:06.000Z",
            "profilePhoto": "tWshQBZEVa",
            "landline": "(435) 353-4211",
            "cellphone": "(123) 456-7890",
            "ext": "123",
            "costRate": 0,
            "billableRate": 0,
            "rateCriterion": "COST",
            "rateBasis": "HOURLY",
            "firstname": "Business",
            "lastname": "Admin"
        },
        "updatedBy": {
            "id": 3,
            "firstName": "Business",
            "lastName": "Admin",
            "username": "engineering+prod@smartserv.io",
            "email": "engineering+prod@smartserv.io",
            "isAdmin": true,
            "roleId": 7,
            "companyId": 3,
            "timeZoneId": 1,
            "isActive": true,
            "isDeleted": false,
            "updatedBy": "app_rw@10.0.2.150",
            "updatedAt": "2026-04-29T12:13:02.000Z",
            "createdAt": "2020-10-27T13:52:06.000Z",
            "profilePhoto": "tWshQBZEVa",
            "landline": "(435) 353-4211",
            "cellphone": "(123) 456-7890",
            "ext": "123",
            "costRate": 0,
            "billableRate": 0,
            "rateCriterion": "COST",
            "rateBasis": "HOURLY",
            "firstname": "Business",
            "lastname": "Admin"
        },
        "createdAt": "2026-09-07T13:08:50.000Z",
        "updatedAt": "2026-09-07T13:08:50.000Z",
        "assignments": [
            {
                "id": 2790843,
                "endTime": "2026-09-14T15:15:00.000Z",
                "startTime": "2026-09-14T13:15:00.000Z",
                "assignmentStatusId": 1,
                "technicianId": 4705,
                "description": "",
                "ticketId": 1924543,
                "travelTime": 0,
                "deviceId": 1,
                "recurringAssignmentId": 1788786528,
                "companyId": 3,
                "isActive": true,
                "isDeleted": false,
                "updatedUserId": 3,
                "createdUserId": 3,
                "createdBy": "app_rw@10.0.2.181",
                "updatedBy": "app_rw@10.0.2.181",
                "createdAt": "2026-09-07T13:08:50.000Z",
                "updatedAt": "2026-09-07T13:08:50.000Z",
                "technician": {
                    "id": 4705,
                    "firstName": "1Ank",
                    "lastName": "ww",
                    "username": "maitri.maniya@smartserv.io",
                    "email": "maitri.maniya@smartserv.io",
                    "isAdmin": false,
                    "roleId": 1380,
                    "companyId": 3,
                    "timeZoneId": 1,
                    "isActive": true,
                    "isDeleted": false,
                    "updatedBy": "app_rw@10.0.2.181",
                    "updatedAt": "2026-08-03T20:10:32.000Z",
                    "createdAt": "2022-08-16T11:04:44.000Z",
                    "profilePhoto": "0",
                    "costRate": 0,
                    "billableRate": 0,
                    "rateCriterion": "COST",
                    "rateBasis": "HOURLY",
                    "firstname": "1Ank",
                    "lastname": "ww"
                },
                "status": "Open",
                "assignmentStatusCFId": 2,
                "statusCF": "Open: return trip needed"
            },
            {
                "id": 2790844,
                "endTime": "2026-09-14T15:15:00.000Z",
                "startTime": "2026-09-14T13:15:00.000Z",
                "assignmentStatusId": 1,
                "technicianId": 10697,
                "description": "",
                "ticketId": 1924543,
                "travelTime": 0,
                "deviceId": 1,
                "recurringAssignmentId": 1788786529,
                "companyId": 3,
                "isActive": true,
                "isDeleted": false,
                "updatedUserId": 3,
                "createdUserId": 3,
                "createdBy": "app_rw@10.0.2.181",
                "updatedBy": "app_rw@10.0.2.181",
                "createdAt": "2026-09-07T13:08:50.000Z",
                "updatedAt": "2026-09-07T13:08:50.000Z",
                "technician": {
                    "id": 10697,
                    "firstName": "20",
                    "lastName": "go 1",
                    "username": "20go@zt.pro",
                    "email": "20go@zt.pro",
                    "isAdmin": false,
                    "roleId": 17,
                    "companyId": 3,
                    "timeZoneId": 1,
                    "isActive": true,
                    "isDeleted": false,
                    "updatedBy": "app_rw@10.0.3.159",
                    "updatedAt": "2025-11-20T13:59:39.000Z",
                    "createdAt": "2025-11-20T13:59:38.000Z",
                    "profilePhoto": 10697,
                    "landline": "3029 8490",
                    "cellphone": "3498 3294",
                    "ext": "",
                    "costRate": 0,
                    "billableRate": 0,
                    "rateCriterion": "COST",
                    "rateBasis": "HOURLY",
                    "referenceId": "",
                    "firstname": "20",
                    "lastname": "go 1"
                },
                "status": "Open",
                "assignmentStatusCFId": 2,
                "statusCF": "Open: return trip needed"
            }
        ],
        "quickbookData": [],
        "readyForSync": true,
        "combinedFeatureFlag": "RECURRING_VISIT",
        "jobStatus": "Open",
        "jobType": "AC Repair",
        "workType": "destined to fail",
        "workCode": "destined to fail",
        "campaign": {
            "id": 1,
            "name": "Facebook",
            "cost": 100,
            "image": "NVxSehymj4",
            "companyId": 3,
            "isActive": true,
            "isDeleted": false,
            "createdUserId": 3,
            "updatedUserId": 3,
            "createdBy": "api_rw@10.0.4.197",
            "updatedBy": "api_rw@10.0.3.174",
            "createdAt": "2020-10-29T08:18:49.000Z",
            "updatedAt": "2022-04-22T08:47:00.000Z",
            "campaignName": "Facebook"
        },
        "serviceAddress": {
            "id": 418,
            "addressLine1": "2074 Steeles Avenue East1",
            "addressLine2": "line-21",
            "city": "Brampton1",
            "state": "AK",
            "zipcode": "12345",
            "country": "US",
            "geoLocation": {
                "lat": 43.7104832,
                "lng": -79.6860795
            },
            "companyId": 3,
            "isTaxable": true,
            "customerId": 368,
            "addressTypeId": 2,
            "isActive": true,
            "isDeleted": false,
            "doNotServe": false,
            "createdBy": "api_rw@10.0.3.174",
            "updatedBy": "api_rw@10.0.2.181",
            "updatedAt": "2022-05-10T11:32:07.000Z",
            "createdAt": "2020-11-28T00:51:52.000Z",
            "createdUserId": 3,
            "updatedUserId": 3,
            "isTCEFireApplicable": false,
            "serviceAddressSync": [],
            "firstname": "28thh",
            "lastname": "November ",
            "name": "Nov Com12",
            "additionalName": "november",
            "landline": "(123) 456-7890",
            "ext": "32822",
            "cellphone": "(348) 324-8122",
            "email": "sandeep@smartserv.iooo",
            "displayName": "Nov Com12",
            "customerIdentifier": "Nov Com (8361869)",
            "customerUniqueId": "Nov Com (8361869)",
            "rootParentId": "",
            "parentId": "",
            "isProspect": false,
            "addressType": "serviceAddress",
            "additionalContacts": [
                {
                    "id": 28,
                    "name": "abc",
                    "email": "abc@s.iooo",
                    "landline": "(000) 000-0000",
                    "ext": "22222",
                    "cellphone": "(666) 666-6666",
                    "addressId": 418,
                    "companyId": 3,
                    "createdBy": "api_rw@10.0.3.174",
                    "updatedBy": "api_rw@10.0.3.174",
                    "updatedAt": "2020-11-28T01:15:44.000Z",
                    "createdAt": "2020-11-28T00:51:52.000Z",
                    "createdUserId": 3,
                    "updatedUserId": 3,
                    "isActive": true,
                    "isDeleted": false
                }
            ],
            "notes": {
                "id": 97,
                "text": "November notes 1",
                "isActive": true,
                "isDeleted": false,
                "isPrivate": false,
                "createdUser": 3,
                "updatedUser": 3,
                "createdBy": "api_rw@10.0.3.174",
                "updatedBy": "api_rw@10.0.3.174",
                "createdAt": "2020-11-28T00:51:52.000Z",
                "updatedAt": "2020-11-28T00:51:52.000Z"
            }
        },
        "company": {
            "id": 3,
            "name": "Test Partner Fire",
            "tagLine": "Dekh Lenge...",
            "isActive": true,
            "isDeleted": false,
            "updatedAt": "2026-09-01T10:35:23.000Z",
            "createdAt": "2020-10-27T13:52:06.000Z",
            "companyUrl": "",
            "administrator": 1018,
            "timeZoneId": 1,
            "localeISOCode": "es-MX",
            "vertical": "Fire",
            "timezoneRegionName": "America/Matamoros",
            "defaultLanguage": "English",
            "defaultCurrencyCode": "GTQ",
            "dstEnabled": false,
            "isMigrated": true,
            "redirectDetails": {
                "IOS": "https://apps.apple.com/us/app/zentrades/id1667202612",
                "WEB": "",
                "ANDROID": ""
            },
            "isMigratedToAsset": false
        },
        "customer": {
            "id": 368,
            "companyId": 3,
            "displayName": "Nov Com12",
            "firstname": "28thh",
            "lastname": "November ",
            "name": "Nov Com12",
            "additionalName": "november",
            "landline": "(123) 456-7890",
            "ext": "32822",
            "cellphone": "(348) 324-8122",
            "email": "sandeep@smartserv.iooo",
            "customerIdentifier": "Nov Com (8361869)",
            "customerUniqueId": "Nov Com (8361869)",
            "skipLevel": false,
            "isActive": true,
            "isDeleted": false,
            "createdBy": "api_rw@10.0.3.174",
            "updatedBy": "smarsterv_admin@10.0.3.174",
            "updatedAt": "2024-03-01T12:01:05.000Z",
            "createdAt": "2020-11-28T00:51:52.000Z",
            "createdUserId": 3,
            "updatedUserId": 3,
            "quickbookData": [
                {
                    "id": 4841,
                    "customerId": 368,
                    "companyId": 3,
                    "qbListId": "",
                    "qbEditSequence": "",
                    "lastSyncedAt": "2021-02-05T15:29:33.000Z",
                    "isSynced": false,
                    "isDeleted": false,
                    "createdBy": "api_rw@10.0.3.37",
                    "updatedBy": "smarsterv_admin@10.0.3.174",
                    "createdAt": "2021-02-05T15:29:32.000Z",
                    "updatedAt": "2024-05-29T09:48:45.000Z",
                    "flowInvoiceInParent": false
                }
            ],
            "readyForSync": true,
            "isProspect": false,
            "billingAddress": {
                "id": 417,
                "addressLine1": "2074 Steeles Avenue East2",
                "addressLine2": "line-22",
                "city": "Brampton2",
                "state": "YT",
                "zipcode": "L6T 4Z2",
                "country": "Canada",
                "companyId": 3,
                "isTaxable": true,
                "customerId": 368,
                "propertyTypeId": 1,
                "addressTypeId": 1,
                "paymentTermId": "dUkidQiwnN",
                "isActive": true,
                "isDeleted": false,
                "doNotServe": false,
                "createdBy": "api_rw@10.0.3.174",
                "updatedBy": "api_rw@10.0.3.174",
                "updatedAt": "2020-11-28T01:12:53.000Z",
                "createdAt": "2020-11-28T00:51:52.000Z",
                "createdUserId": 3,
                "updatedUserId": 3,
                "isTCEFireApplicable": false,
                "firstname": "28thh",
                "lastname": "November ",
                "name": "Nov Com12",
                "additionalName": "november",
                "landline": "(123) 456-7890",
                "ext": "32822",
                "cellphone": "(348) 324-8122",
                "email": "sandeep@smartserv.iooo",
                "displayName": "Nov Com12",
                "customerIdentifier": "Nov Com (8361869)",
                "customerUniqueId": "Nov Com (8361869)",
                "rootParentId": "",
                "parentId": "",
                "isProspect": false,
                "additionalContacts": [
                    {
                        "id": 27,
                        "name": "abc",
                        "email": "abc@s.io",
                        "landline": "(000) 000-0000",
                        "ext": "22222",
                        "cellphone": "(888) 888-8888",
                        "addressId": 417,
                        "companyId": 3,
                        "createdBy": "api_rw@10.0.3.174",
                        "updatedBy": "api_rw@10.0.3.174",
                        "updatedAt": "2020-11-28T01:12:52.000Z",
                        "createdAt": "2020-11-28T00:51:52.000Z",
                        "createdUserId": 3,
                        "updatedUserId": 3,
                        "isActive": true,
                        "isDeleted": false
                    }
                ],
                "notes": {
                    "id": 96,
                    "text": "November notes 2",
                    "isActive": true,
                    "isDeleted": false,
                    "isPrivate": false,
                    "createdUser": 3,
                    "updatedUser": 3,
                    "createdBy": "api_rw@10.0.3.174",
                    "updatedBy": "api_rw@10.0.3.174",
                    "createdAt": "2020-11-28T00:51:52.000Z",
                    "updatedAt": "2020-11-28T00:51:52.000Z"
                }
            }
        },
        "rruleDetails": {
            "id": 415914,
            "rrule": "DTSTART;TZID=Asia/Calcutta:20260907T131513\nRRULE:FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYDAY=MO,SU,TU,WE,TH,FR,SA;COUNT=14",
            "rruleUid": "01M1XZRQDT2005YXWT92DHTZ6N",
            "moduleId": 6,
            "moduleEntityId": "1924543",
            "entityGenerated": true,
            "nthEvent": 8,
            "companyId": 3,
            "isDeleted": false,
            "createdBy": "app_rw@10.0.2.181",
            "updatedBy": "app_rw@10.0.2.181",
            "createdAt": "2026-09-07T13:08:51.000Z",
            "updatedAt": "2026-09-07T13:08:51.000Z",
            "rruleString": "every day for 14 times"
        }
    }
}
```



## 3. API for auth

- POST [https://services.zentrades.pro/api/auth/login](https://services.zentrades.pro/api/auth/login)

```
{
    "username": "",
    "password": "",
    "rememberMe": true
}
```

Sample Response: 

```
{
    "status": "success",
    "requestId": null,
    "result": {
        "user": {
            "id": 689,
            "firstName": "Support",
            "lastName": "SmartServ",
            "username": "supporteverest@smartserv.io",
            "email": "supporteverest@smartserv.io",
            "isAdmin": true,
            "roleId": 337,
            "timeZoneId": 256,
            "currencyId": 254,
            "isActive": true,
            "isDeleted": false,
            "updatedBy": "app_rw@10.0.2.181",
            "updatedAt": "2026-08-05T14:32:10.000Z",
            "createdAt": "2021-03-11T07:24:42.000Z",
            "about": "admin for this company",
            "objectId": "aLJzh7mWb9",
            "cellphone": "(206) 826-9074",
            "rateCriterion": "COST",
            "rateBasis": "HOURLY",
            "company": {
                "id": 82,
                "companyIdentifier": "MWAVxWvnbn",
                "name": "Everest Drain & Plumbing",
                "isActive": true,
                "isDeleted": false,
                "updatedAt": "2026-09-01T11:55:48.000Z",
                "createdAt": "2019-07-29T13:51:30.000Z",
                "companyUrl": "",
                "administrator": 694,
                "localeISOCode": "en-US",
                "timezoneRegionName": "America/Toronto",
                "defaultLanguage": "English",
                "defaultCurrencyCode": "CAD",
                "dstEnabled": false,
                "isMigrated": true,
                "redirectDetails": {
                    "IOS": "https://apps.apple.com/us/app/zentrades/id1667202612",
                    "WEB": "",
                    "ANDROID": ""
                },
                "isMigratedToAsset": false
            },
            "roleDetails": {
                "id": 337,
                "name": "Administrator",
                "companyId": 82,
                "isActive": true,
                "isDeleted": false,
                "createdUserId": 1,
                "updatedUserId": 1,
                "updatedBy": "api_rw@10.0.3.78",
                "updatedAt": "2021-03-11T07:24:42.000Z",
                "createdAt": "2021-03-11T07:24:42.000Z"
            },
            "profile": {
                "id": 1,
                "objectId": 0,
                "name": "Administrator",
                "isActive": true,
                "isDeleted": false,
                "createdUserId": 1,
                "updatedUserId": 1
            },
            "profileId": 1,
            "permissions": {
                "20": {
                    "readAccess": true,
                    "writeAccess": true,
                    "deleteAccess": true
                }
            },
            "role": 0,
            "firstname": "Support",
            "lastname": "SmartServ",
            "profilePic": false,
            "settings": {
                "id": "EDha19H30U",
                "isFieldManager": false,
                "userCanAddTicket": false,
                "allowEditJobTypeFromField": true,
                "signupPrivilege": true,
                "showScheduler": false,
                "showReports": false,
                "isSupportAccount": true,
                "adminPrivilege": false,
                "userId": 689,
                "createdAt": "2021-03-11T13:10:28.268Z",
                "updatedAt": "2026-08-04T20:20:01.226Z",
                "companyId": 82,
                "allowEditVisitDescription": false,
                "allowEditLocationNotes": false
            },
            "modulePreferences": [
                {
                    "id": "XvWZ7KMIMN",
                    "moduleId": 6,
                    "preferences": {
                        "defaultPageLimit": 50
                    },
                    "userId": 689,
                    "companyId": 82,
                    "createdUserId": 689,
                    "updatedUserId": 689,
                    "createdAt": "2025-12-23T15:29:31.994Z",
                    "updatedAt": "2025-12-23T15:29:31.994Z"
                }
            ],
            "ticketTableFilters": [],
            "defaultTicketFilter": {},
            "invoiceTableFilters": [],
            "defaultInvoiceFilter": {},
            "estimateTableFilters": [],
            "defaultEstimateFilter": {},
            "hasSeenAnnouncement": false,
            "bannerAnnouncement": {
                "announcementId": "c1a57708-8e26-49ae-818d-734648641859",
                "targetRoles": [
                    "admin",
                    "dispatcher",
                    "office",
                    "manager"
                ],
                "platform": "crm",
                "createdAt": "2026-08-26T17:01:15.704Z",
                "currentOccurrenceIndex": 1
            },
            "hasSeenBannerAnnouncement": "c1a57708-8e26-49ae-818d-734648641859_1"
        },
        "access-token": "<redacted — was a live JWT; decoded payload for reference: {userId, companyId, roleId, roleName, profileName, uuid, iat, exp}. iat/exp were exactly 86400s apart despite rememberMe:true — see auth notes.>",
        "VAPID_PUBLIC": "BPP3Htf3UfRW-VUkGHT7CMaoFJLlx9vpCrdvsoxn1FM6sBrmY4XbLEMc5Lnlo21QZkPU0XjzR4QTWxKXtUQHeeA"
    }
}
```



## 4. API for posting note:

```
- curl --url 'https://services.zentrades.pro/api/note/ticket/create/v2?timestamp=1788953812887' \
  -H 'accept: */*' \
  -H 'accept-language: en-GB,en-US;q=0.9,en;q=0.8' \
  -H 'access-token: <redacted — a live JWT; obtain one from the login endpoint in §3>' \
  -H 'company-id: 3' \
  -H 'content-type: application/json;charset=UTF-8' \
  -H 'origin: https://app.zentrades.pro' \
  -H 'priority: u=1, i' \
  -H 'referer: https://app.zentrades.pro/' \
  -H 'request-from: WEB_APP' \
  -H 'sec-ch-ua: "Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'sec-ch-ua-platform: "macOS"' \
  -H 'sec-fetch-dest: empty' \
  -H 'sec-fetch-mode: cors' \
  -H 'sec-fetch-site: same-site' \
  -H 'timezone-offset: -330' \
  -H 'timezonename: Asia/Calcutta' \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36' \
  -H 'user-id: 3' \
  --data-raw '{"ticketId":1924543,"text":"Test Note for the API","isPrivate":false,"addAttachments":[],"deleteAttachments":[]}'
```

- Sample Response:

```
{
    "status": "success",
    "requestId": null,
    "result": {
        "id": 3189254,
        "text": "Test Note for the API",
        "companyId": 3,
        "isActive": true,
        "isDeleted": false,
        "isPrivate": false,
        "createdUser": 3,
        "updatedUser": 3,
        "createdBy": "app_rw@10.0.3.159",
        "updatedBy": "app_rw@10.0.3.159",
        "createdAt": "2026-09-09T11:36:53.000Z",
        "updatedAt": "2026-09-09T11:36:53.000Z"
    }
}
```



## 5. API for updating job - api_doc/ztticket_update.md

