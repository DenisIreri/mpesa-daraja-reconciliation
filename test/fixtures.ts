/** Callback payloads shaped exactly like the ones Daraja sends. Fake IDs and numbers only. */

export function paidCallback(checkoutRequestId: string, receipt: string, amount: number) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: `mr-${checkoutRequestId}`,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: amount },
            { Name: "MpesaReceiptNumber", Value: receipt },
            { Name: "Balance" },
            { Name: "TransactionDate", Value: 20260115120501 },
            { Name: "PhoneNumber", Value: 254700000000 },
          ],
        },
      },
    },
  };
}

export function failedCallback(checkoutRequestId: string, resultCode: number, desc: string) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: `mr-${checkoutRequestId}`,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: resultCode,
        ResultDesc: desc,
      },
    },
  };
}
