const Razorpay = require('razorpay');
const crypto = require('crypto');
const Faculty = require('../models/Faculty');
const TokenTransaction = require('../models/TokenTransaction');

// Defined Recharge plans
const PLANS = [
  { id: 'plan_basic', priceInRupees: 99, tokens: 100, name: 'Basic Plan' },
  { id: 'plan_standard', priceInRupees: 299, tokens: 350, name: 'Standard Plan' },
  { id: 'plan_premium', priceInRupees: 999, tokens: 1500, name: 'Premium Plan' },
  { id: 'plan_enterprise', priceInRupees: 2499, tokens: 5000, name: 'Enterprise Plan' }
];

// Helper to get razorpay instance
function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error('Razorpay API keys are not configured in environment variables.');
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret
  });
}

exports.getPlans = (req, res) => {
  res.json({ success: true, plans: PLANS });
};

exports.createOrder = async (req, res) => {
  try {
    const { planId } = req.body;

    // Authentication protection before using req.faculty.id
    if (!req.faculty || !req.faculty.id) {
      return res.status(401).json({
        success: false,
        error: "Faculty authentication missing"
      });
    }

    const plan = PLANS.find(p => p.id === planId);
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan selected.' });
    }

    const rzp = getRazorpayInstance();

    const options = {
      amount: plan.priceInRupees * 100, // paise
      currency: 'INR',
      receipt: `receipt_order_${Date.now()}`,
      notes: {
        facultyId: req.faculty.id,
        planId: planId
      }
    };

    const order = await rzp.orders.create(options);

    const transaction = await TokenTransaction.create({
      facultyId: req.faculty.id,
      type: 'credit',
      amount: plan.tokens,
      description: `Recharged Plan: ${plan.name} (${plan.tokens} Tokens)`,
      status: 'pending',
      orderId: order.id,
      credited: false
    });

    await Faculty.findByIdAndUpdate(req.faculty.id, {
      $push: { transactionHistory: transaction._id }
    });

    res.status(201).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      plan
    });
  } catch (err) {
    console.error("FULL ERROR IN createOrder:", err);

    res.status(500).json({
      success: false,
      message: "Failed to create payment order",
      error:
        err.message ||
        err.error?.description ||
        err.response?.data ||
        "Unknown error",
      stack: err.stack
    });
  }
};

exports.verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing required Razorpay parameters.' });
    }

    // Cryptographic signature verification
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const generatedSignature = hmac.digest('hex');

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment signature verification failed. Untrusted request.' });
    }

    // Atomic update checking for credited: false
    let transaction = await TokenTransaction.findOneAndUpdate(
      { orderId: razorpay_order_id, credited: false },
      {
        $set: {
          paymentId: razorpay_payment_id,
          signature: razorpay_signature,
          status: 'success',
          credited: true
        }
      },
      { new: true }
    );

    if (!transaction) {
      // If no transaction was updated, check if it's because it was already credited:
      const alreadyCredited = await TokenTransaction.findOne({ orderId: razorpay_order_id, credited: true });
      if (alreadyCredited) {
        return res.json({
          success: true,
          message: 'Payment verified and tokens already credited.',
          tokens: alreadyCredited.amount
        });
      }

      // If it doesn't exist at all, fetch order from Razorpay to construct details and create atomically as credited: true
      const rzp = getRazorpayInstance();
      const rzpOrder = await rzp.orders.fetch(razorpay_order_id);
      
      let amount = 0;
      let description = 'Direct Payment Verification';
      const plan = PLANS.find(p => p.priceInRupees * 100 === rzpOrder.amount);
      if (plan) {
        amount = plan.tokens;
        description = `Recharged Plan: ${plan.name} (${plan.tokens} Tokens)`;
      } else {
        const inferredTokens = Math.round(rzpOrder.amount / 100);
        amount = inferredTokens;
        description = `Custom Recharge (${inferredTokens} Tokens)`;
      }

      try {
        transaction = await TokenTransaction.findOneAndUpdate(
          { orderId: razorpay_order_id },
          {
            $setOnInsert: {
              facultyId: req.faculty.id,
              type: 'credit',
              amount: amount,
              description: description,
              orderId: razorpay_order_id,
              paymentId: razorpay_payment_id,
              signature: razorpay_signature,
              status: 'success',
              credited: true
            }
          },
          { upsert: true, new: true, runValidators: true }
        );
      } catch (upsertErr) {
        // If write collision, fetch the transaction
        const fallbackTx = await TokenTransaction.findOne({ orderId: razorpay_order_id });
        if (fallbackTx && fallbackTx.credited) {
          return res.json({
            success: true,
            message: 'Payment verified and tokens already credited.',
            tokens: fallbackTx.amount
          });
        }
        throw upsertErr;
      }
    }

    // Increment user tokens atomically (only runs once per successful payment verification)
    await Faculty.findByIdAndUpdate(transaction.facultyId, {
      $inc: { availableTokens: transaction.amount },
      $addToSet: { transactionHistory: transaction._id }
    });

    res.json({
      success: true,
      message: 'Payment verified and tokens credited successfully.',
      tokens: transaction.amount
    });
  } catch (err) {
    console.error("verifyPayment FULL ERROR:", err);

    res.status(500).json({
      success: false,
      message: "Payment verification failed",
      error:
        err.message ||
        err.error?.description ||
        err.response?.data ||
        "Unknown error",
      stack: err.stack
    });
  }
};

exports.handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      return res.status(200).json({ status: 'ignored', reason: 'Webhook secret not set' });
    }

    if (!signature) {
      return res.status(400).json({ error: 'Missing webhook signature.' });
    }

    const shasum = crypto.createHmac('sha256', webhookSecret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      return res.status(400).json({ error: 'Invalid webhook signature.' });
    }

    const event = req.body.event;
    console.log(`[Razorpay Webhook] Received event: ${event}`);

    if (event === 'order.paid' || event === 'payment.captured') {
      const paymentEntity = req.body.payload.payment.entity;
      const orderId = paymentEntity.order_id;
      const paymentId = paymentEntity.id;

      // Try to find and update transaction atomically
      let transaction = await TokenTransaction.findOneAndUpdate(
        { orderId: orderId, credited: false },
        {
          $set: {
            paymentId: paymentId,
            status: 'success',
            credited: true
          }
        },
        { new: true }
      );

      if (!transaction) {
        // Check if already credited
        const alreadyCredited = await TokenTransaction.findOne({ orderId: orderId, credited: true });
        if (alreadyCredited) {
          console.log(`[Razorpay Webhook] Order ${orderId} already credited. Skipping.`);
          return res.status(200).json({ status: 'duplicate', message: 'Tokens already credited.' });
        }

        // Recover from metadata notes
        const notes = paymentEntity.notes || {};
        const facultyId = notes.facultyId;
        const planId = notes.planId;

        if (facultyId && planId) {
          const plan = PLANS.find(p => p.id === planId);
          let amount = plan ? plan.tokens : Math.round(paymentEntity.amount / 100);
          let description = plan ? `Recharged Plan: ${plan.name} (${plan.tokens} Tokens)` : `Custom Recharge (${amount} Tokens)`;

          try {
            transaction = await TokenTransaction.findOneAndUpdate(
              { orderId: orderId },
              {
                $setOnInsert: {
                  facultyId: facultyId,
                  type: 'credit',
                  amount: amount,
                  description: description,
                  orderId: orderId,
                  paymentId: paymentId,
                  status: 'success',
                  credited: true
                }
              },
              { upsert: true, new: true, runValidators: true }
            );
          } catch (upsertErr) {
            const fallbackTx = await TokenTransaction.findOne({ orderId: orderId });
            if (fallbackTx && fallbackTx.credited) {
              console.log(`[Razorpay Webhook] Collision fallback. Order ${orderId} already credited.`);
              return res.status(200).json({ status: 'ok', message: 'Already credited' });
            }
            throw upsertErr;
          }
        } else {
          // If notes are missing, fetch from Razorpay Orders API
          const rzp = getRazorpayInstance();
          const rzpOrder = await rzp.orders.fetch(orderId);
          const orderNotes = rzpOrder.notes || {};
          const rzpFacultyId = orderNotes.facultyId;
          const rzpPlanId = orderNotes.planId;

          if (rzpFacultyId) {
            const plan = PLANS.find(p => p.id === rzpPlanId || p.priceInRupees * 100 === rzpOrder.amount);
            let amount = plan ? plan.tokens : Math.round(rzpOrder.amount / 100);
            let description = plan ? `Recharged Plan: ${plan.name} (${plan.tokens} Tokens)` : `Custom Recharge (${amount} Tokens)`;

            try {
              transaction = await TokenTransaction.findOneAndUpdate(
                { orderId: orderId },
                {
                  $setOnInsert: {
                    facultyId: rzpFacultyId,
                    type: 'credit',
                    amount: amount,
                    description: description,
                    orderId: orderId,
                    paymentId: paymentId,
                    status: 'success',
                    credited: true
                  }
                },
                { upsert: true, new: true, runValidators: true }
              );
            } catch (upsertErr) {
              const fallbackTx = await TokenTransaction.findOne({ orderId: orderId });
              if (fallbackTx && fallbackTx.credited) {
                return res.status(200).json({ status: 'ok', message: 'Already credited' });
              }
              throw upsertErr;
            }
          } else {
            console.error(`[Razorpay Webhook] Missing facultyId for Order ${orderId} recovery.`);
            return res.status(400).json({ error: 'Cannot credit transaction. Missing faculty identity.' });
          }
        }
      }

      // Increment faculty balance atomically
      await Faculty.findByIdAndUpdate(transaction.facultyId, {
        $inc: { availableTokens: transaction.amount },
        $addToSet: { transactionHistory: transaction._id }
      });

      console.log(`[Razorpay Webhook] Successfully credited ${transaction.amount} tokens to Faculty ID ${transaction.facultyId} for Order ${orderId}`);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error("Webhook FULL ERROR:", err);

    res.status(500).json({
      success: false,
      message: "Webhook error",
      error:
        err.message ||
        err.error?.description ||
        err.response?.data ||
        "Unknown error",
      stack: err.stack
    });
  }
};
