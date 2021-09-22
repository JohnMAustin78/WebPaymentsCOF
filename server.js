// micro provides http helpers
const { createError, json, send } = require('micro');
// microrouter provides http server routing
const { router, get, post } = require('microrouter');
// serve-handler serves static assets
const staticHandler = require('serve-handler');
// async-retry will retry failed API requests
const retry = require('async-retry');

// logger gives us insight into what's happening
const logger = require('./server/logger');
// schema validates incoming requests
const { validatePaymentPayload } = require('./server/schema');
// square provides the API client and error types
const { ApiError, client: square } = require('./server/square');
const { nanoid } = require('nanoid');

async function createPayment(req, res) {
  const payload = await json(req);
  logger.debug(JSON.stringify(payload));
  // We validate the payload for specific fields. You may disable this feature
  // if you would prefer to handle payload validation on your own.
  if (!validatePaymentPayload(payload)) {
    throw createError(400, 'Bad Request');
  }
  await retry(async (bail, attempt) => {
    try {
      logger.debug('Creating payment', { attempt });

      const idempotencyKey = payload.idempotencyKey || nanoid();
      const payment = {
        idempotencyKey,
        locationId: payload.locationId,
        sourceId: payload.sourceId,
        // While it's tempting to pass this data from the client
        // Doing so allows bad actor to modify these values
        // Instead, leverage Orders to create an order on the server
        // and pass the Order ID to createPayment rather than raw amounts
        // See Orders documentation: https://developer.squareup.com/docs/orders-api/what-it-does
        amountMoney: {
          // the expected amount is in cents, meaning this is $1.00.
          amount: '100',
          // If you are a non-US account, you must change the currency to match the country in which
          // you are accepting the payment.
          currency: 'USD',
        },
      };

      // VerificationDetails is part of Secure Card Authentication.
      // This part of the payload is highly recommended (and required for some countries)
      // for 'unauthenticated' payment methods like Cards.
      if (payload.verificationToken) {
        payment.verificationToken = payload.verificationToken;
      }

      const { result, statusCode } = await square.paymentsApi.createPayment(
        payment
      );

      logger.info('Payment succeeded!', { result, statusCode });

      send(res, statusCode, {
        success: true,
        payment: {
          id: result.payment.id,
          status: result.payment.status,
          receiptUrl: result.payment.receiptUrl,
          orderId: result.payment.orderId,
        },
      });
    } catch (ex) {
      if (ex instanceof ApiError) {
        // likely an error in the request. don't retry
        logger.error(ex.errors);
        bail(ex);
      } else {
        // IDEA: send to error reporting service
        logger.error(`Error creating payment on attempt ${attempt}: ${ex}`);
        throw ex; // to attempt retry
      }
    }
  });
}
async function createCard(req, res) {
  const payload = await json(req);
  logger.debug(JSON.stringify(payload));
  if (!validateCardPayload(payload)) {
    throw createError(400, 'Bad Request');
  }

  await retry(async (bail, attempt) => {
    try {
      logger.debug('Creating card on file', { attempt });

      const card = {
        expMonth: payload.expMonth,
        expYear: payload.expYear,
        cardHolderName: payload.cardHolderName,
        customerId: payload.customerID,
      };
      const cardRequest = {
        card: card,
        idempotencyKey: payload.idempotencyKey || nanoid(),
        sourceId: payload.sourceId,
        verificationToken: payload.verificationToken,
      }

      const { result, statusCode } = await square.cardsApi.createCard(
        cardRequest
      );

      logger.info('Create card succeeded!', { result, statusCode });

      send(res, statusCode, {
        success: true,
        card: {
          id: result.card.id,
        },
      });
    } catch (ex) {
      if (ex instanceof ApiError) {
        // likely an error in the request. don't retry
        logger.error(ex.errors);
        bail(ex);
      } else {
        // IDEA: send to error reporting service
        logger.error(`Error creating payment on attempt ${attempt}: ${ex}`);
        throw ex; // to attempt retry
      }
    }
  });

}

async function listCards(req, res) {
  const payload = await json(req);
  logger.debug(JSON.stringify(payload));
  if (!validateListCardsPayload(payload)) {
    throw createError(400, 'Bad Request');
  }


  await retry(async (bail, attempt) => {
    try {
      logger.debug('Listing customer cards', { attempt });

      const { result, statusCode } = await client.cardsApi.listCards(payload.customerId);
      

      logger.info('Cards found!', { result, statusCode });

      const cardsResult = result[0].card;
      send(res, statusCode, {
        success: true,
        card: {
          id: cardsResult.id,
          card_brand: cardsResult.cardBrand,
          last4: cardsResult.last4,
        },
      });
    } catch (ex) {
      if (ex instanceof ApiError) {
        // likely an error in the request. don't retry
        logger.error(ex.errors);
        bail(ex);
      } else {
        // IDEA: send to error reporting service
        logger.error(`Error searching for customer on attempt ${attempt}: ${ex}`);
        throw ex; // to attempt retry
      }
    }
  });

}

async function searchCustomers(req,res) {
  const payload = await json(req);
  logger.debug(JSON.stringify(payload));
  if (!validateSearchCustomerPayload(payload)) {
    throw createError(400, 'Bad Request');
  }

  await retry(async (bail, attempt) => {
    try {
      logger.debug('Searching for customer', { attempt });

      const { result, statusCode } = await client.customersApi.searchCustomers({
        query: {
          filter: {
            emailAddress: {
              exact: payload.emailAddress
            }
          }
        }
      });
      

      logger.info('Customer found!', { result, statusCode });

      const customerResult = result[0].customer;
      send(res, statusCode, {
        success: true,
        customer: {
          id: customerResult.id,
          given_name: customerResult.givenName,
          family_name: customerResult.familyName,
        },
      });
    } catch (ex) {
      if (ex instanceof ApiError) {
        // likely an error in the request. don't retry
        logger.error(ex.errors);
        bail(ex);
      } else {
        // IDEA: send to error reporting service
        logger.error(`Error searching for customer on attempt ${attempt}: ${ex}`);
        throw ex; // to attempt retry
      }
    }
  });
}

// serve static files like index.html and favicon.ico from public/ directory
async function serveStatic(req, res) {
  logger.debug('Handling request', req.path);
  await staticHandler(req, res, {
    public: 'public',
  });
}

// export routes to be served by micro
module.exports = router(
  post('/cof', createCard),
  post('/payment', createPayment),
  get('/*', serveStatic),
  get('/cards', listCards),
  post('/searchCustomer', searchCustomers)
);
