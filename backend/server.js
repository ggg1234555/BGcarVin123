const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors());
app.use(express.json());

// Multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Search endpoint
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query || query.trim().length === 0) {
      return res.status(400).json({ error: 'Невалиден VIN/рег. №' });
    }

    // First check local database
    let localResult = await supabase
      .from('cars')
      .select('*')
      .or(`plate.eq.${query},vin.eq.${query}`)
      .single();

    if (localResult.data) {
      return res.json({
        source: 'local',
        data: {
          make: localResult.data.make,
          model: localResult.data.model,
          year: localResult.data.year,
          hp: localResult.data.hp,
          mileage: localResult.data.mileage,
          notes: localResult.data.notes,
          photos: localResult.data.photos || [],
          plate: localResult.data.plate,
          vin: localResult.data.vin
        }
      });
    }

    // If not found locally and query is 17 chars (VIN), try NHTSA
    if (query.length === 17) {
      try {
        const nhtsa_response = await axios.get(
          `https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${query}?format=json`
        );

        if (nhtsa_response.data && nhtsa_response.data.Results) {
          const results = nhtsa_response.data.Results;
          
          // Extract relevant data from NHTSA response
          const findValue = (field) => {
            const item = results.find(r => r.Variable === field);
            return item && item.Value && item.Value !== 'Not Applicable' ? item.Value : null;
          };

          const data = {
            make: findValue('Make'),
            model: findValue('Model'),
            year: findValue('Model Year'),
            bodyClass: findValue('Body Class'),
            fuelType: findValue('Fuel Type - Primary'),
            engineHP: findValue('Engine Power (kW)'),
            vin: query
          };

          // Convert kW to HP if available
          if (data.engineHP) {
            data.hp = Math.round(parseFloat(data.engineHP) * 1.341);
          }

          return res.json({
            source: 'nhtsa',
            data: data
          });
        }
      } catch (error) {
        console.error('NHTSA API error:', error);
        return res.status(503).json({ error: 'Външното API не отговаря' });
      }
    }

    // No results found
    res.status(404).json({ error: 'Не са намерени данни за този автомобил' });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Грешка при търсенето' });
  }
});

// Submit car endpoint
app.post('/api/submit', upload.array('photos', 5), async (req, res) => {
  try {
    const { plate, vin, hp, mileage, year, make, model, notes, consent } = req.body;

    // Validate consent
    if (consent !== 'true') {
      return res.status(400).json({ error: 'Моля, потвърдете съгласието си' });
    }

    // Validate required fields
    if (!plate && !vin) {
      return res.status(400).json({ error: 'Моля, въведете рег. № или VIN' });
    }

    let photoUrls = [];

    // Upload photos if provided
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}-${file.originalname}`;
        const filePath = `car-photos/${fileName}`;

        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('photos')
          .upload(filePath, file.buffer, {
            contentType: file.mimetype,
            cacheControl: '3600'
          });

        if (uploadError) {
          console.error('Photo upload error:', uploadError);
          continue;
        }

        // Get public URL
        const { data: urlData } = supabase.storage
          .from('photos')
          .getPublicUrl(filePath);

        if (urlData) {
          photoUrls.push(urlData.publicUrl);
        }
      }
    }

    // Insert car record
    const { data: carData, error: carError } = await supabase
      .from('cars')
      .insert({
        plate: plate || null,
        vin: vin || null,
        hp: hp ? parseInt(hp) : null,
        mileage: mileage ? parseInt(mileage) : null,
        year: year ? parseInt(year) : null,
        make: make || null,
        model: model || null,
        notes: notes || null,
        photos: photoUrls.length > 0 ? photoUrls : null,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (carError) {
      console.error('Database insert error:', carError);
      return res.status(500).json({ error: 'Грешка при записването в базата данни' });
    }

    res.json({ 
      success: true, 
      message: 'Автомобилът е добавен успешно',
      id: carData.id 
    });

  } catch (error) {
    console.error('Submit error:', error);
    res.status(500).json({ error: 'Грешка при добавянето на автомобила' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});