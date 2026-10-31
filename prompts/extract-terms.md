1. **Role:** "You are reviewing a residential lease for a tenant."
2. **Task:**  List the fields: rent amount, due date, lease start and end, availability for pets, security deposit, termination and notice terms.
3. **Instructions:** 
   - Quote the exact clause text for each field.
   - If a term isn't in the lease, return `null` and don't guess.
   - Don't give legal advice.
   - Always return one entry for every category in the example (rent, term, renewal, termination, deposit, pets). If the lease doesn't address one, set its summary, details and source to null.
4. **Output format:** the JSON shape you want back. 

{
    
  "lease_terms": [
    {
      "category": "rent",
      "summary": "Rent is $1,250 per month.",

      "details": {
        "amount": 1250.00, 
        "currency": "USD", 
        "frequency": "monthly"},

      "source": {
        "section": "3.1", 
        "page": 2,
        "quote": "Tenant shall pay..."}
    },


    {
      "category": "renewal",
      "summary": "The lease renews automatically for one year.",

      {"term_length": "1 year",
       "automatic": true}

      "source": {
        "section": "4.2",
        "page": 3
      }
    },

    {
      "category": "termination",
      "summary": "",

        "details": {
       {"notice_days": 30}},


      "source": {
        "section": "12.1",
        "page": 8
      }
    },

     {
      "category": "deposit",
      "summary": "Rent is $1,250 per month.",

      "details": {
        "amount": 1000.00, 
        "currency": "USD", 
        "frequency": "one time"},

      "source": {
        "section": "3.1", 
        "page": 2,
        "quote": "Tenant shall provide..."}
    },

     {
      "category": "pets",
      "summary": "Pets are generally not allowed.",

      "details": {
        "exemptions": "Service animals only", 
        "number_of_animals: "Up to three service animals..."}
        
      "source": {
        "section": "3.1", 
        "page": 2,
        "quote": "Tenant shall pay..."}
    },
  
  ]
}


