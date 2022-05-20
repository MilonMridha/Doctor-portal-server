const express = require('express');
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const nodemailer = require('nodemailer');
const sgTransport = require('nodemailer-sendgrid-transport');
const app = express();
const port = process.env.PORT || 5000;


const stripe = require('stripe')(process.env.STRIPE_SECRET)
//middleware--------->
// app.use(cors());
//cors policy config--------->
const corsConfig = {
    origin: true,
    Credentials: true,
}
app.use(cors(corsConfig))
app.options('*', cors(corsConfig));


app.use(express.json())



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.aetvy.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: 'UnAuthorized access' })
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'Forbidden access' })
        }
        req.decoded = decoded;
        next();
    })
}
const emailOptions = {
    auth: {

        api_key: process.env.EMAIL_SENDER_KEY
    }
}
const emailClient = nodemailer.createTransport(sgTransport(emailOptions));

function sendAppointmentEmail(booking) {
    const {patient, patientName, treatment, date, slot } = booking;

    var email = {
        from: process.env.EMAIL_SENDER,
        to: patient,
        subject: `Your Appointment for ${treatment} is on ${date} at ${slot} is confirmed`,
        text: `Your Appointment for ${treatment} is on ${date} at ${slot} is confirmed`,
        html: `
        <div>
            <h1>Hello, ${patientName}<h1>
            <p>your Appointment for ${treatment} is confirmed</p>
            <p> Looking forward to seeing you on ${date} at ${slot}.</p>
            <p>Our address</p>
            <p>Andor killa bandorban</p>
            <a href="https://nodemailer.com/about/">unsubscribe</a>
        </div>`
      };
      emailClient.sendMail(email, function(err, info){
        if (err ){
          console.log(err);
        }
        else {
          console.log('Message sent: ', info);
        }
    });
}



async function run() {
    try {
        await client.connect();
        const serviceCollection = client.db('doctor-portal').collection('service');
        const bookingCollection = client.db('doctor-portal').collection('booking');
        const userCollection = client.db('doctor-portal').collection('users');
        const doctorsCollection = client.db('doctor-portal').collection('doctors');
        const paymentCollection = client.db('doctor-portal').collection('payment');

        const verifyAdmin = async (req, res, next) => {
            const requester = req.decoded.email;
            const requesterAccount = await userCollection.findOne({ email: requester });
            if (requesterAccount.role === 'admin') {
                next();
            }
            else {
                res.status(403).send({ message: 'Forbidden' });
            }
        }

        app.post('/create-payment-intent', verifyJWT, async(req, res)=>{
            const service = req.body;
            const price = service.price;
            const amount = price*100;
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd',
                payment_method_types:['card']

            });
            res.send({clientSecret: paymentIntent.client_secret})
        });

        //api------->
        app.get('/service', async (req, res) => {
            const query = {};
            const cursor = serviceCollection.find(query).project({ name: 1 });
            const result = await cursor.toArray();
            res.send(result);
        });
        app.get('/admin/:email', async (req, res) => {
            const email = req.params.email;
            const user = await userCollection.findOne({ email: email });
            const isAdmin = user.role === 'admin';
            res.send({ admin: isAdmin });
        })

        //Admin collection
        app.put('/user/admin/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            const filter = { email: email };
            const updateDoc = {
                $set: { role: 'admin' }
            };
            const result = await userCollection.updateOne(filter, updateDoc);
            res.send(result);
        });

        app.put('/user/:email', async (req, res) => {
            const email = req.params.email;

            const user = req.body;

            const filter = { email: email };
            const options = { upsert: true };
            const updateDoc = {
                $set: user,
            };
            const result = await userCollection.updateOne(filter, updateDoc, options);
            const token = jwt.sign({ email: email }, process.env.ACCESS_TOKEN_SECRET, {
                expiresIn: '1h'
            })
            res.send({ result, token });
        });

        app.delete('/user/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const result = await userCollection.deleteOne(query);
            res.send(result);
        });

        app.get('/available', async (req, res) => {
            const date = req.query.date;

            //step 1: get all services------>
            const services = await serviceCollection.find().toArray();

            //step 2: get the Booking of the day [{}, {}, {},{}]---->
            const query = { date: date };
            const booking = await bookingCollection.find(query).toArray();

            //step 3: foreach service, find bookings for that service [{}, {}, {},{}]---->
            services.forEach(service => {
                //step 4: find bookings for that service---->
                const serviceBookings = booking.filter(book => book.treatment === service.name);
                // step 5: selected slots for the service Bookings: ['', '', '', '']------>
                const bookedSlots = serviceBookings.map(book => book.slot);
                //step 6: select those slots that are not in bookedSlots------>
                const available = service.slots.filter(slot => !bookedSlots.includes(slot));
                service.slots = available;



            });

            res.send(services);
        });
        app.get('/booking', verifyJWT, async (req, res) => {
            const patient = req.query.patient;
            const decodedEmail = req.decoded.email;
            if (patient === decodedEmail) {
                const query = { patient: patient };
                const bookings = await bookingCollection.find(query).toArray();
                return res.send(bookings);
            }
            else {
                return res.status(403).send({ message: 'forbidden access' })
            }

        });
        app.get('/booking/:id',verifyJWT, async(req, res) =>{
            const id = req.params.id;
            const query = {_id: ObjectId(id)};
            const result = await bookingCollection.findOne(query);
            res.send(result);
        })
        //booking api post------>
        app.post('/booking', async (req, res) => {
            const booking = req.body;
            const filter = { treatment: booking.treatment, date: booking.date, patient: booking.patient };
            const exist = await bookingCollection.findOne(filter);
            if (exist) {
                return res.send({ success: false, booking: exist })
            }
            else {
                const result = await bookingCollection.insertOne(booking);
                console.log('sending email')
                // sendAppointmentEmail(booking);
                res.send({ success: true, result })
            }

        });
        app.patch('/booking/:id', verifyJWT, async(req, res)=>{
            const id = req.params.id;
            const payment = req.body;
            const filter = {_id: ObjectId(id)};
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            };
            const result = await paymentCollection.insertOne(payment);
            const updatedBooking = await bookingCollection.updateOne(filter, updatedDoc);
            res.send(updatedDoc);
        })
        app.get('/user', verifyJWT, async (req, res) => {
            const users = await userCollection.find().toArray();
            res.send(users)
        });
        app.get('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
            const doctors = await doctorsCollection.find().toArray();
            res.send(doctors)
        })
        app.post('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result);
        })
        app.delete('/doctor/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            const filter = { email: email }
            const result = await doctorsCollection.deleteOne(filter);
            res.send(result);
        });
    }




    finally {

    }
}
run().catch(console.dir);






app.get('/', (req, res) => {
    res.send('Doctor Portal Server is Running')
});
app.listen(port, () => {
    console.log('Doctor listening to port', port)
})