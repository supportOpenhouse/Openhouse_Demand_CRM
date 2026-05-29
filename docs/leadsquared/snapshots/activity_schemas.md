# Custom Activity Schemas

Captured **23** custom activity schemas.

## Converse Chat (code 219)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Start Time | DateTime |  |
| `mx_Custom_2` | End Time | DateTime |  |
| `mx_Custom_3` | Chat Attended | String |  |
| `mx_Custom_4` | Session End Type | String |  |
| `mx_Custom_5` | Agent Assigned | String |  |
| `mx_Custom_6` | Ended By | String |  |
| `mx_Custom_7` | Business Phone Number | String |  |
| `mx_Custom_8` | Lead Phone Number | String |  |
| `mx_Custom_9` | Session ID | String |  |
| `mx_Custom_10` | Channel | String |  |
| `mx_Custom_11` | Messages sent by agent | Number |  |
| `mx_Custom_12` | Messages sent by lead | Number |  |
| `mx_Custom_13` | First response time | String |  |
| `mx_Custom_14` | Average response time | String |  |

## Demand- After Visit Follow Up (code 221)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Follow Up - Date and Time | DateTime |  |
| `mx_Custom_2` | Re-Visit Date & Time | DateTime |  |
| `mx_Custom_3` | Pipeline Status | SearchableDropdown |  |

## Demand- ATS Signed (code 217)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | ATS Signed ? | SearchableDropdown |  |
| `mx_Custom_2` | ATS Signature Date | DateTime |  |
| `mx_Custom_3` | Balance Amount Status | SearchableDropdown |  |
| `mx_Custom_4` | Follow Up Date and Time | DateTime |  |
| `mx_Custom_5` | Payment Follow Up Date | DateTime |  |
| `mx_Custom_6` | Alpha | Number |  |
| `mx_Custom_7` | Beta | Number |  |

## Demand- Booking Done (code 216)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Token Amount | Number |  |
| `mx_Custom_2` | Transaction  Details Upload | CustomObject |  |
| `mx_Custom_4` | Balance Amount | Number |  |
| `mx_Custom_5` | Booking Done ? | SearchableDropdown |  |
| `mx_Custom_6` | Follow Up Date | DateTime |  |
| `mx_Custom_3` | Sale Amount | Number |  |
| `mx_Custom_7` | Brokerage Percentage | Number |  |
| `mx_Custom_8` | ATS Date | DateTime |  |
| `mx_Custom_9` | Lead Status | SearchableDropdown |  |

## Demand- Negotiation (code 215)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Follow Up - Date and Time | DateTime |  |
| `mx_Custom_2` | Cancelled Reason | SearchableDropdown |  |
| `mx_Custom_3` | Booking Done | SearchableDropdown |  |
| `mx_Custom_4` | Lead Status | SearchableDropdown |  |

## Demand- Payment Status (code 220)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Balance Amount Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Payment Follow Up | DateTime |  |
| `mx_Custom_2` | Lead Status | SearchableDropdown |  |

## Demand- Phone Call (code 212)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Call Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Outcome  | SearchableDropdown |  |
| `mx_Custom_2` | Lead Status | SearchableDropdown |  |
| `mx_Custom_3` | Follow Up Date and Time | DateTime |  |
| `mx_Custom_4` | Not Interested - Reason | SearchableDropdown |  |
| `mx_Custom_5` | Call Not Answered - Reason | SearchableDropdown |  |

## Demand- Visit Status (code 214)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Home Visit Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Next Action | SearchableDropdown |  |
| `mx_Custom_2` | Re-Visit Date & Time | DateTime |  |
| `mx_Custom_3` | Follow Up Date and Time | DateTime |  |
| `mx_Custom_4` | Site Visit Date and Time | DateTime |  |
| `mx_Custom_5` | Cancelled Reason | SearchableDropdown |  |
| `mx_Custom_6` | Lead Status | SearchableDropdown |  |

## Demand- Visit to be Scheduled (code 213)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Visit Date & Time | DateTime |  |
| `mx_Custom_2` | House required in | String |  |
| `mx_Custom_3` | Follow Up Date and Time | DateTime |  |
| `mx_Custom_4` | Lead Status | SearchableDropdown |  |

## Document Designer - Document Generation (code 21600)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Template ID | String |  |
| `mx_Custom_2` | Template Version | String |  |
| `mx_Custom_3` | Reason | String |  |

## Home Visit (code 202)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Home Visit Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Cancelled Reason | SearchableDropdown |  |
| `mx_Custom_2` | Follow Up - Date and Time | DateTime |  |
| `mx_Custom_3` | Site Visit Date and Time | DateTime |  |
| `mx_Custom_4` | Next Action | SearchableDropdown |  |
| `mx_Custom_5` | Rejection Reason | SearchableDropdown |  |

## Inventory not available (code 218)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | House required in | SearchableDropdown |  |

## Lead Qualification (code 201)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Not Qualified Reason | SearchableDropdown |  |
| `mx_Custom_2` | Next Action | SearchableDropdown |  |

## Meeting -CP (code 207)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Meeting Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Outcome  | SearchableDropdown |  |
| `mx_Custom_2` | Follow Up - Date  and Time  | DateTime |  |
| `mx_Custom_3` | Not Interested - Reason | String |  |

## Negotiation & Token (code 205)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Negotiation Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Follow Up - Date and Time | DateTime |  |
| `mx_Custom_2` | Token Amount | Number |  |
| `mx_Custom_3` | Transaction Details Upload | CustomObject |  |
| `mx_Custom_4` | Negotiation Reasons | SearchableDropdown |  |

## Offer Qualification (code 203)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Next Action | SearchableDropdown |  |
| `mx_Custom_2` | Rejection Reason | SearchableDropdown |  |
| `mx_Custom_3` | Meeting Date & Time | DateTime |  |

## Phone Call (code 200)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Call Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Follow Up - Date and Time | DateTime |  |
| `mx_Custom_2` | Reason | SearchableDropdown |  |
| `mx_Custom_3` | Outcome | SearchableDropdown |  |
| `mx_Custom_4` | Not Interested Reason | String |  |
| `mx_Custom_5` | Lead Status | SearchableDropdown |  |
| `mx_Custom_6` | Future Prospect Follow Up | DateTime |  |
| `mx_Custom_7` | Meeting – Date & Time  | DateTime |  |

## Phone Call- CP (code 206)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Call Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Remarks | String |  |
| `mx_Custom_2` | Call Not Answered - Reason | SearchableDropdown |  |
| `mx_Custom_3` | Follow Up - Date and Time | DateTime |  |
| `mx_Custom_4` | Outcome | SearchableDropdown |  |
| `mx_Custom_5` | Lead Status | SearchableDropdown |  |
| `mx_Custom_6` | Not Interested - Reason | String |  |
| `mx_Custom_7` | Meeting – Date & Time  | DateTime |  |

## Regular Interaction Call -CP (code 208)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Call Status  | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Call Not  Answered - Reason | SearchableDropdown |  |
| `mx_Custom_2` | Follow Up - Date  and Time  | DateTime |  |
| `mx_Custom_3` | Add New Deal | SearchableDropdown |  |
| `mx_Custom_4` | Add New Demand Deal | SearchableDropdown |  |

## Schedule Seller Meeting (code 209)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Seller Meeting Scheduled | SearchableDropdown |  |
| `mx_Custom_2` | Meeting Date & Time | DateTime |  |
| `mx_Custom_3` | Follow Up Date and Time | DateTime |  |
| `mx_Custom_4` | Token Amount | Number |  |
| `mx_Custom_5` | Upload Transaction Details | CustomObject |  |

## Seller Meeting Details (code 204)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `ActivityEvent_Note` | Notes | String |  |
| `Status` | Meeting Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Rejection Reason | SearchableDropdown |  |
| `mx_Custom_2` | Follow Up - Date and Time | DateTime |  |
| `mx_Custom_3` | Token Amount | Number |  |
| `mx_Custom_4` | Upload Transaction Details | CustomObject |  |

## Share Lead (code 211)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Share Lead With | ActiveUsers |  |
| `ActivityEvent_Note` | Notes | String |  |

## WhatsApp Message (code 210)
| Schema Name | Display | Type | Mandatory |
|---|---|---|---|
| `Status` | Status | SearchableDropdown |  |
| `Owner` | Owner | ActiveUsers |  |
| `mx_Custom_1` | Status date | DateTime | ✓ |
| `mx_Custom_2` | Direction | SearchableDropdown | ✓ |
| `mx_Custom_3` | Automation Id | String |  |
| `mx_Custom_4` | Automation Action Id | String |  |
